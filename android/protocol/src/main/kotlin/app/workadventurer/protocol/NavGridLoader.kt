package app.workadventurer.protocol

import app.workadventurer.nav.CollisionBuilder
import app.workadventurer.nav.NavGrid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

private const val DAY_MS = 24L * 3_600_000

/**
 * Builds the room's [NavGrid] from its `.wam` (already fetched), the `.tmj` it points at, and, when the `.wam` lists them, the
 * entity collections that give each piece of furniture its real collision shape ([loadEntityGrids]). The `.tmj` is ~1.5 MB, so
 * it is cached on disk; a stale cache is used if the refetch fails. Null if anything is unusable.
 */
suspend fun loadNavGrid(
    http: OkHttpClient,
    wamJson: String,
    cacheDir: File? = null,
    nowMs: () -> Long = System::currentTimeMillis,
    ttlMs: Long = DAY_MS,
): NavGrid? = withContext(Dispatchers.IO) {
    try {
        val mapUrl = Json.parseToJsonElement(wamJson).jsonObject["mapUrl"]?.jsonPrimitive?.contentOrNull
            ?: return@withContext null
        val grids = loadEntityGrids(http, wamJson, cacheDir, nowMs, ttlMs)
        val file = cacheDir?.let { File(it, sha1(mapUrl) + ".tmj") }
        val cached = file?.takeIf { it.isFile }
        if (cached != null && nowMs() - cached.lastModified() < ttlMs) {
            CollisionBuilder.build(wamJson, cached.readText(), grids)?.let { return@withContext it }
        }
        val fresh = download(http, mapUrl)
        val grid = fresh?.let { CollisionBuilder.build(wamJson, it, grids) }
        if (grid != null) {
            // Cache only a body that really built into a grid: an HTML error page served with a 200 would otherwise
            // be replayed as "no grid" for the whole TTL.
            if (file != null) runCatching {
                file.parentFile.mkdirs()
                val tmp = File(file.parentFile, file.name + ".part")
                tmp.writeText(fresh)
                tmp.renameTo(file)
            }
            return@withContext grid
        }
        // a stale map beats no map
        cached?.let { CollisionBuilder.build(wamJson, it.readText(), grids) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

/**
 * The room's `.tmj` text: from the disk cache when it is fresh, else downloaded and cached. The same cache entry [loadNavGrid]
 * reads, so a room that needs its map before joining (to find a tile start layer) does not download it a second time. Only a
 * body that is a JSON object is cached or returned, so an HTML error page served with a 200 can never poison the cache.
 */
suspend fun loadMapText(
    http: OkHttpClient,
    wamJson: String,
    cacheDir: File? = null,
    nowMs: () -> Long = System::currentTimeMillis,
    ttlMs: Long = DAY_MS,
): String? = withContext(Dispatchers.IO) {
    try {
        val mapUrl = Json.parseToJsonElement(wamJson).jsonObject["mapUrl"]?.jsonPrimitive?.contentOrNull
            ?: return@withContext null
        cachedJson(http, mapUrl, cacheDir?.let { File(it, sha1(mapUrl) + ".tmj") }, nowMs, ttlMs)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

/**
 * What each prefab of furniture really blocks. The `.wam` lists the entity collection files it uses (`entityCollections`,
 * entries of `type: "file"` have a public URL); each collection entry has a `collisionGrid` of 0/1 rows (32 px cells from the
 * entity's top-left), and an entry without one is not solid. Keys are the prefab ids the `.wam`'s entities use,
 * `"<collection>:<name>:<color>:<direction>"`. Null when no collection could be loaded, so the caller keeps the old, coarser
 * furniture approximation (blocking all furniture as 3x3 squares split the campus map into 20 islands).
 */
suspend fun loadEntityGrids(
    http: OkHttpClient,
    wamJson: String,
    cacheDir: File? = null,
    nowMs: () -> Long = System::currentTimeMillis,
    ttlMs: Long = DAY_MS,
): Map<String, List<List<Int>>?>? = withContext(Dispatchers.IO) {
    try {
        val urls = (Json.parseToJsonElement(wamJson).jsonObject["entityCollections"] as? JsonArray).orEmpty().mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            if ((o["type"] as? JsonPrimitive)?.contentOrNull == "file") (o["url"] as? JsonPrimitive)?.contentOrNull else null
        }.distinct()
        if (urls.isEmpty()) return@withContext null
        val texts = coroutineScope {
            urls.map { url -> async { cachedJson(http, url, cacheDir?.let { File(it, sha1(url) + ".coll") }, nowMs, ttlMs) } }.awaitAll()
        }
        val out = HashMap<String, List<List<Int>>?>()
        var loaded = 0
        for (text in texts) {
            val o = text?.let { try { Json.parseToJsonElement(it) as? JsonObject } catch (e: Exception) { null } } ?: continue
            val collection = (o["collectionName"] as? JsonPrimitive)?.contentOrNull ?: continue
            loaded++
            for (entry in (o["collection"] as? JsonArray).orEmpty()) {
                val eo = entry as? JsonObject ?: continue
                val name = (eo["name"] as? JsonPrimitive)?.contentOrNull ?: continue
                val color = (eo["color"] as? JsonPrimitive)?.contentOrNull ?: continue
                val direction = (eo["direction"] as? JsonPrimitive)?.contentOrNull ?: continue
                out["$collection:$name:$color:$direction"] = parseGrid(eo["collisionGrid"])
            }
        }
        if (loaded == 0) null else out
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

private fun parseGrid(e: kotlinx.serialization.json.JsonElement?): List<List<Int>>? {
    val rows = e as? JsonArray ?: return null
    val grid = rows.map { row -> (row as? JsonArray ?: return null).map { (it as? JsonPrimitive)?.intOrNull ?: return null } }
    return grid.takeIf { it.isNotEmpty() }
}

/** [url]'s body if it is a JSON object: from [file] when fresh, else downloaded and cached there; a stale copy if the download fails. */
private fun cachedJson(http: OkHttpClient, url: String, file: File?, nowMs: () -> Long, ttlMs: Long): String? {
    val cached = file?.takeIf { it.isFile }?.readText()?.takeIf { isJsonObject(it) }
    if (cached != null && nowMs() - file.lastModified() < ttlMs) return cached
    val fresh = download(http, url)?.takeIf { isJsonObject(it) }
    if (fresh != null) {
        if (file != null) runCatching {
            file.parentFile.mkdirs()
            val tmp = File(file.parentFile, file.name + ".part")
            tmp.writeText(fresh)
            tmp.renameTo(file)
        }
        return fresh
    }
    return cached // a stale copy beats none
}

private fun isJsonObject(s: String) = try { Json.parseToJsonElement(s) is JsonObject } catch (e: Exception) { false }

private const val DOWNLOAD_TIMEOUT_S = 60L

private fun download(http: OkHttpClient, url: String): String? = try {
    // A hung server must not pin this blocking call forever (closing the connection can't interrupt it otherwise).
    val client = http.newBuilder().callTimeout(DOWNLOAD_TIMEOUT_S, java.util.concurrent.TimeUnit.SECONDS).build()
    client.newCall(Request.Builder().url(url).build()).execute().use {
        if (it.isSuccessful) it.body?.string() else null
    }
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    null
}

private fun sha1(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
