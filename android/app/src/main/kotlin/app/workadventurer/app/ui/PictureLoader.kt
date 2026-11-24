package app.workadventurer.app.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Fetches a world's thumbnail (a public picture the map author links to) for the Join screen. Only https, at most [MAX_BYTES], shrunk
 * to about [targetWidth] pixels wide so a large preview doesn't fill memory. A failure is null: the tile just shows no picture.
 * Platform glue, checked on the phone.
 */
class PictureLoader(private val http: OkHttpClient, private val targetWidth: Int = 720) {
    private val pictures = LruCache<String, ImageBitmap>(8)

    suspend fun load(url: String): ImageBitmap? {
        if (!url.startsWith("https://")) return null
        pictures.get(url)?.let { return it }
        val built = withContext(Dispatchers.IO) { fetch(url) } ?: return null
        pictures.put(url, built)
        return built
    }

    private fun fetch(url: String): ImageBitmap? = try {
        http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            val body = r.body
            if (!r.isSuccessful || body == null || (body.contentLength() > MAX_BYTES)) return null
            val bytes = body.source().let { it.request(MAX_BYTES + 1); if (it.buffer.size > MAX_BYTES) return null; it.buffer.readByteArray() }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= targetWidth) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
        }
    } catch (e: Exception) {
        null
    }

    private companion object {
        const val MAX_BYTES = 4L * 1024 * 1024
    }
}
