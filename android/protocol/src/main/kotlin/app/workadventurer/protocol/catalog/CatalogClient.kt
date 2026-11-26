package app.workadventurer.protocol.catalog

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.time.Instant

const val DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/campey/workadventurer/main/catalog/index.json"

sealed class IndexEntry {
    /** [added] is the entry's optional `added` instant (ISO-8601), kept only if it parses; null otherwise. */
    data class Ok(val file: String, val sha256: String, val added: String? = null) : IndexEntry()
    data class NeedsAttention(val gate: JsonElement?) : IndexEntry()
}

/** [updated] is the index's top-level `updated` (ISO-8601 instant), kept only if it parses; null otherwise. */
data class CatalogIndex(val url: String, val entries: Map<String, IndexEntry>, val updated: String? = null)

sealed class Fetched<out T> {
    data class Ok<T>(val value: T) : Fetched<T>()
    data class Fail(val reason: String) : Fetched<Nothing>()
}

/** The catalog: the index, then one adapter file. All input is hostile; nothing throws. Blocking calls. */
object CatalogClient {
    const val MAX_INDEX_BYTES = 1024L * 1024
    const val MAX_FILE_BYTES = 64L * 1024
    const val DEFAULT_TIMEOUT_MS = 8000L
    private val FILE_RE = Regex("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
    private val SHA256_RE = Regex("^[0-9a-f]{64}$")

    suspend fun fetchIndex(client: OkHttpClient, url: String = DEFAULT_CATALOG_URL, timeoutMs: Long = DEFAULT_TIMEOUT_MS): Fetched<CatalogIndex> {
        val got = getCapped(client, url, timeoutMs, MAX_INDEX_BYTES)
        if (got is Got.Fail) return Fetched.Fail("index: ${got.reason}")
        val bytes = (got as Got.Bytes).bytes
        // CPU work (parse, validate) never runs on the caller's dispatcher.
        return cpu { parseIndex(url, bytes) }
    }

    private fun parseIndex(url: String, bytes: ByteArray): Fetched<CatalogIndex> {
        val parsed = parseJsonBytes(bytes)
        if (parsed !is Parsed.Value) return Fetched.Fail("index: not valid JSON")
        val raw = parsed.json as? JsonObject
        if (raw == null || !isOne(raw["schema"])) {
            return Fetched.Fail("index: schema must be 1")
        }
        val rawEntries = raw["entries"] as? JsonObject ?: return Fetched.Fail("index: entries must be an object")
        // Keep only entries we could trust; a needs-attention placeholder never carries a usable file.
        val entries = LinkedHashMap<String, IndexEntry>()
        for ((hash, e) in rawEntries) {
            if (!HASH_RE.matches(hash) || e !is JsonObject) continue
            val status = (e["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (status == "needs-attention") {
                entries[hash] = IndexEntry.NeedsAttention(e["gate"])
            } else if (status == "ok") {
                val file = (e["file"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                val sha = (e["sha256"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (file != null && sha != null && SHA256_RE.matches(sha)) entries[hash] = IndexEntry.Ok(file, sha, validInstant(e["added"]))
            }
        }
        val updated = validInstant(raw["updated"])
        return Fetched.Ok(CatalogIndex(url, entries, updated))
    }

    /** An ISO-8601 instant string of sane length, or null. */
    private fun validInstant(e: JsonElement?): String? =
        (e as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.length <= 64 && runCatching { Instant.parse(it) }.isSuccess }

    private fun sameOrigin(a: HttpUrl, b: HttpUrl) = a.scheme == b.scheme && a.host == b.host && a.port == b.port

    /** The URL [fetchAdapterFile] would fetch for [entry], or why it is refused (other origin, outside the index's directory, odd path). */
    fun resolveAdapterUrl(indexUrl: String, entry: IndexEntry.Ok): Fetched<HttpUrl> {
        return try {
            val base = indexUrl.toHttpUrl()
            val resolved = base.resolve(entry.file) ?: return Fetched.Fail("file URL is invalid")
            if (!sameOrigin(base, resolved)) return Fetched.Fail("file URL is not on the index's origin (${resolved.scheme}://${resolved.host}:${resolved.port})")
            val dir = base.encodedPath.substring(0, base.encodedPath.lastIndexOf('/') + 1)
            if (!resolved.encodedPath.startsWith(dir)) return Fetched.Fail("file URL is outside the index's directory")
            if (!FILE_RE.matches(entry.file) || entry.file.split('/').any { it == ".." || it == "." }) return Fetched.Fail("file path is not allowed")
            if (resolved.username.isNotEmpty() || resolved.password.isNotEmpty() || resolved.query != null || resolved.fragment != null) {
                return Fetched.Fail("file URL must be a plain path")
            }
            Fetched.Ok(resolved)
        } catch (e: Exception) {
            Fetched.Fail("file URL is invalid")
        }
    }

    /** The validated adapter URL to show in the consent dialog: only when it passes [resolveAdapterUrl] and is https; else null. */
    fun displayAdapterUrl(indexUrl: String, entry: IndexEntry.Ok): String? =
        (resolveAdapterUrl(indexUrl, entry) as? Fetched.Ok)?.value?.takeIf { it.isHttps }?.toString()

    /** Fetch and fully verify one adapter file; returns the validated file and its raw text (for the cache). */
    suspend fun fetchAdapterFile(
        client: OkHttpClient, indexUrl: String, hash: String, entry: IndexEntry.Ok, timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    ): Fetched<Pair<AdapterFile, String>> {
        val fileUrl: HttpUrl = when (val r = resolveAdapterUrl(indexUrl, entry)) {
            is Fetched.Fail -> return r
            is Fetched.Ok -> r.value
        }
        val got = getCapped(client, fileUrl.toString(), timeoutMs, MAX_FILE_BYTES)
        if (got is Got.Fail) return Fetched.Fail("adapter $hash: ${got.reason}")
        val bytes = (got as Got.Bytes).bytes
        return cpu { verifyAdapterFile(hash, entry, bytes) }
    }

    private fun verifyAdapterFile(hash: String, entry: IndexEntry.Ok, bytes: ByteArray): Fetched<Pair<AdapterFile, String>> {
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        if (sha != entry.sha256) return Fetched.Fail("adapter $hash: sha256 does not match the index")
        val parsed = parseJsonBytes(bytes)
        if (parsed !is Parsed.Value) return Fetched.Fail("adapter $hash: not valid JSON")
        return when (val c = validateAdapterFile(parsed.json)) {
            is Checked.Bad -> Fetched.Fail("adapter $hash: ${c.reason}")
            is Checked.Ok ->
                if (c.file.apiVersionHash != hash) Fetched.Fail("adapter $hash: file's apiVersionHash is ${c.file.apiVersionHash}")
                else Fetched.Ok(c.file to String(bytes, Charsets.UTF_8))
        }
    }
}
