package app.workadventurer.protocol

import app.workadventurer.nav.CollisionBuilder
import app.workadventurer.nav.NavGrid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

private const val DAY_MS = 24L * 3_600_000

/**
 * Builds the room's [NavGrid] from its `.wam` (already fetched) and the `.tmj` it points at. The `.tmj` is
 * ~1.5 MB, so it is cached on disk; a stale cache is used if the refetch fails. Null if anything is unusable.
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
        val file = cacheDir?.let { File(it, sha1(mapUrl) + ".tmj") }
        val cached = file?.takeIf { it.isFile }
        if (cached != null && nowMs() - cached.lastModified() < ttlMs) {
            CollisionBuilder.build(wamJson, cached.readText())?.let { return@withContext it }
        }
        val fresh = download(http, mapUrl)
        val grid = fresh?.let { CollisionBuilder.build(wamJson, it) }
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
        cached?.let { CollisionBuilder.build(wamJson, it.readText()) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

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
