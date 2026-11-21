package app.workadventurer.protocol.catalog

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient

/** What the server's home page says about its version; [hash] is the wa-api-version meta, [release] e.g. `v1.34.4` or `master@abc1234`. */
data class ServerVersion(val hash: String?, val release: String?)

object ServerVersionReader {
    const val MAX_PAGE_BYTES = 512L * 1024
    private const val MAX_TAG = 2048
    private val NAME = Regex("\\bname\\s*=\\s*[\"']wa-api-version[\"']", RegexOption.IGNORE_CASE)
    private val CONTENT = Regex("\\bcontent\\s*=\\s*[\"']([^\"']*)[\"']", RegexOption.IGNORE_CASE)

    /** The wa-api-version meta content if it is a valid hash; null otherwise. */
    fun matchApiHash(html: String): String? {
        // Linear scan (a hostile page must not make this quadratic): each tag is cut at the next '>' and
        // only looked at if it is short.
        var i = 0
        var end = -1
        while (true) {
            i = html.indexOf("<meta", i, ignoreCase = true)
            if (i < 0) return null
            if (end < i) { end = html.indexOf('>', i); if (end < 0) return null }
            val next = html.getOrNull(i + 5)
            if (end - i <= MAX_TAG && (next == null || !(next.isLetterOrDigit() || next == '_'))) {
                val tag = html.substring(i, end + 1)
                if (NAME.containsMatchIn(tag)) {
                    return CONTENT.find(tag)?.groupValues?.get(1)?.takeIf { HASH_RE.matches(it) }
                }
            }
            i += 5
        }
    }

    fun matchRelease(html: String): String? =
        Regex("v\\d+\\.\\d+\\.\\d+").find(html)?.value ?: Regex("master@[0-9a-f]{7,40}").find(html)?.value

    /**
     * GET the room URL's origin and read the version; null on any failure or when neither value is found.
     * Redirects are refused on purpose (a catalog-relevant hash must come from the server itself).
     */
    suspend fun read(client: OkHttpClient, roomUrl: String, timeoutMs: Long = 8000): ServerVersion? {
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
