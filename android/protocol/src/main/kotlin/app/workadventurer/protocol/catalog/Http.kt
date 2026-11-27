package app.workadventurer.protocol.catalog

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okio.Buffer
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

internal sealed class Got {
    class Bytes(val bytes: ByteArray) : Got()
    class Fail(val reason: String) : Got()
}

private fun failure(e: Throwable): Got.Fail {
    if (e is InterruptedIOException && e !is SocketTimeoutException && e.message == "interrupted") {
        Thread.currentThread().interrupt()
        return Got.Fail("interrupted")
    }
    if (e is InterruptedIOException) return Got.Fail("timed out")
    return Got.Fail(e.message ?: e.javaClass.simpleName)
}

private fun readBody(res: Response, requested: okhttp3.HttpUrl, maxBytes: Long, truncate: Boolean): Got {
    if (res.code in 300..399) return Got.Fail("unexpected redirect (HTTP ${res.code})")
    val a = res.request.url
    if (a.scheme != requested.scheme || a.host != requested.host || a.port != requested.port) return Got.Fail("response came from a different origin")
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
    return Got.Bytes(buf.readByteArray())
}

/**
 * GET reading at most [maxBytes] of the body. Cancelling the coroutine cancels the OkHttp call (so a
 * cancelled recovery stops reading at once). One call timeout covers headers and body, redirects are
 * never followed (any 3xx is a failure), an over-cap Content-Length is refused before reading and an
 * over-cap stream is cut as soon as the total passes the cap. Never throws except coroutine
 * cancellation. With [truncate] the body is cut at the cap and returned instead of refused.
 */
internal suspend fun getCapped(client: OkHttpClient, url: String, timeoutMs: Long, maxBytes: Long, truncate: Boolean = false): Got {
    val call: Call
    val req: Request
    try {
        req = Request.Builder().url(url).build()
        call = client.newBuilder().followRedirects(false).followSslRedirects(false)
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build().newCall(req)
    } catch (e: Exception) {
        return Got.Fail("bad URL")
    }
    return suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { cont.resume(failure(e)) }
            override fun onResponse(call: Call, response: Response) {
                val got = try { response.use { readBody(it, req.url, maxBytes, truncate) } } catch (e: Throwable) { failure(e) }
                cont.resume(got)
            }
        })
    }
}

/** Where CPU-bound work (JSON parse, meta scan, sha256) runs, so it never lands on the caller's dispatcher. Tests swap it to observe that. */
internal object CpuWork {
    @Volatile var dispatcher: kotlinx.coroutines.CoroutineDispatcher = kotlinx.coroutines.Dispatchers.Default
}

internal suspend fun <T> cpu(block: () -> T): T = kotlinx.coroutines.withContext(CpuWork.dispatcher) { block() }
