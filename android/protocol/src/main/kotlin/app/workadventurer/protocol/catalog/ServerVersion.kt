package app.workadventurer.protocol.catalog

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient

/** What the server's home page says about its version; [hash] is the wa-api-version meta, [release] e.g. `v1.34.4` or `master@abc1234`. */
data class ServerVersion(val hash: String?, val release: String?)

object ServerVersionReader {
    const val MAX_PAGE_BYTES = 512L * 1024

    /** The wa-api-version meta content if it is a valid hash; null otherwise. */
    fun matchApiHash(html: String): String? {
        for (tag in Regex("<meta\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(html)) {
            if (!Regex("\\bname\\s*=\\s*[\"']wa-api-version[\"']", RegexOption.IGNORE_CASE).containsMatchIn(tag.value)) continue
            val c = Regex("\\bcontent\\s*=\\s*[\"']([^\"']*)[\"']", RegexOption.IGNORE_CASE).find(tag.value)
            return c?.groupValues?.get(1)?.takeIf { HASH_RE.matches(it) }
        }
        return null
    }

    fun matchRelease(html: String): String? =
        Regex("v\\d+\\.\\d+\\.\\d+").find(html)?.value ?: Regex("master@[0-9a-f]{7,40}").find(html)?.value

    /** GET the room URL's origin and read the version; null on any failure or when neither value is found. Blocking. */
    fun read(client: OkHttpClient, roomUrl: String, timeoutMs: Long = 8000): ServerVersion? {
        val u = roomUrl.toHttpUrlOrNull() ?: return null
        val origin = u.newBuilder().encodedPath("/").query(null).fragment(null).build().toString()
        val got = getCapped(client, origin, timeoutMs, MAX_PAGE_BYTES, truncate = true)
        if (got !is Got.Bytes) return null
        val html = String(got.bytes, Charsets.UTF_8)
        val hash = matchApiHash(html)
        val release = matchRelease(html)
        return if (hash != null || release != null) ServerVersion(hash, release) else null
    }
}
