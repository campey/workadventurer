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
        val tmj = tmjText(http, mapUrl, cacheDir, nowMs, ttlMs) ?: return@withContext null
        CollisionBuilder.build(wamJson, tmj)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}

private fun tmjText(http: OkHttpClient, url: String, cacheDir: File?, nowMs: () -> Long, ttlMs: Long): String? {
    val file = cacheDir?.let { File(it, sha1(url) + ".tmj") }
    val cached = file?.takeIf { it.isFile }
    if (cached != null && nowMs() - cached.lastModified() < ttlMs) return cached.readText()

    val fresh = try {
        http.newCall(Request.Builder().url(url).build()).execute().use {
            if (it.isSuccessful) it.body?.string() else null
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
    if (fresh != null) {
        if (file != null) runCatching {
            file.parentFile.mkdirs()
            val tmp = File(file.parentFile, file.name + ".part")
            tmp.writeText(fresh)
            tmp.renameTo(file)
        }
        return fresh
    }
    return cached?.readText() // a stale map beats no map
}

private fun sha1(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
