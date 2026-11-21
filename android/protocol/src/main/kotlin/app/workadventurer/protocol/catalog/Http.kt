package app.workadventurer.protocol.catalog

import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit

internal sealed class Got {
    class Bytes(val bytes: ByteArray) : Got()
    class Fail(val reason: String) : Got()
}

/**
 * Blocking GET reading at most [maxBytes] of the body. One call timeout covers headers and body,
 * redirects are never followed (any 3xx is a failure), an over-cap Content-Length is refused
 * before reading and an over-cap stream is cut as soon as the total passes the cap. Never throws.
 * With [truncate] the body is cut at the cap and returned instead of refused.
 */
internal fun getCapped(client: OkHttpClient, url: String, timeoutMs: Long, maxBytes: Long, truncate: Boolean = false): Got {
    return try {
        val c = client.newBuilder().followRedirects(false).followSslRedirects(false)
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build()
        val req = Request.Builder().url(url).build()
        c.newCall(req).execute().use { res ->
            if (res.code in 300..399) return Got.Fail("unexpected redirect (HTTP ${res.code})")
            if (!res.isSuccessful) return Got.Fail("HTTP ${res.code}")
            val body = res.body ?: return Got.Fail("empty response")
            if (!truncate && body.contentLength() > maxBytes) return Got.Fail("body too large (size ${body.contentLength()} bytes, limit $maxBytes)")
            val src = body.source()
            val buf = Buffer()
            while (buf.size <= maxBytes) {
                if (src.read(buf, 8192) == -1L) break
            }
            if (buf.size > maxBytes) {
                if (!truncate) return Got.Fail("body too large (size over $maxBytes bytes)")
                return Got.Bytes(buf.readByteArray(maxBytes))
            }
            Got.Bytes(buf.readByteArray())
        }
    } catch (e: InterruptedIOException) {
        Got.Fail("timed out")
    } catch (e: Exception) {
        Got.Fail(e.message ?: e.javaClass.simpleName)
    }
}
