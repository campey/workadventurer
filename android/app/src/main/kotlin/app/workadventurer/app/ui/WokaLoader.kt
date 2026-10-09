package app.workadventurer.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Rect
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import app.workadventurer.protocol.Texture
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Builds a player's woka picture: fetches each layer (a public PNG sprite sheet, no login), cuts out the standing facing-down
 * frame, and stacks the layers in the server's order into one 32x32 bitmap (see [WokaSprite]). Finished pictures are kept in
 * memory by their layer list, so a person shown on several screens is built once. A layer that can't be fetched or read is
 * skipped; if none can, there is no picture and the caller shows the initial instead. Platform glue, checked on the phone.
 */
class WokaLoader(private val http: OkHttpClient) {
    private val pictures = LruCache<String, ImageBitmap>(64)

    suspend fun load(textures: List<Texture>): ImageBitmap? {
        val key = WokaSprite.cacheKey(textures)
        if (key.isEmpty()) return null
        pictures.get(key)?.let { return it }
        val built = withContext(Dispatchers.IO) { build(textures) } ?: return null
        pictures.put(key, built)
        return built
    }

    private fun build(textures: List<Texture>): ImageBitmap? {
        val out = Bitmap.createBitmap(WokaSprite.FRAME, WokaSprite.FRAME, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val frame = WokaSprite.IDLE_DOWN
        val from = Rect(frame.left, frame.top, frame.left + frame.size, frame.top + frame.size)
        val to = Rect(0, 0, WokaSprite.FRAME, WokaSprite.FRAME)
        var drew = 0
        for (t in textures) {
            val sheet = fetch(t.url) ?: continue
            // a sheet smaller than expected can't hold the frame: skip it rather than crash
            if (sheet.width >= from.right && sheet.height >= from.bottom) { canvas.drawBitmap(sheet, from, to, null); drew++ }
            sheet.recycle()
        }
        return if (drew == 0) null else out.asImageBitmap()
    }

    private fun fetch(url: String): Bitmap? {
        if (!url.startsWith("https://")) return null // textures are public https; anything else isn't ours to fetch
        return try {
            http.newCall(Request.Builder().url(url).build()).execute().use { r ->
                if (!r.isSuccessful) return null
                val bytes = r.body?.bytes() ?: return null
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inScaled = false })
            }
        } catch (e: Exception) {
            null
        }
    }
}
