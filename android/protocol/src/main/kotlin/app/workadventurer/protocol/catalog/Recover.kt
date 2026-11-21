package app.workadventurer.protocol.catalog

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient

enum class AdapterUpdates { ASK, AUTO, NEVER }
enum class AdapterAnswer { YES, NO, ALWAYS }

/** What the consent question is about: the server's hash and release string (e.g. `v1.35.0`), if the page had one. */
data class AdapterOffer(val hash: String, val release: String?)

sealed class RecoverOutcome {
    data class Unavailable(val reason: String) : RecoverOutcome()
    /** A built-in adapter or a loadable cached file covers this hash; [handshakeQuery] is the cached file's (empty for built-ins). */
    data class Known(val hash: String, val handshakeQuery: Map<String, String> = emptyMap()) : RecoverOutcome()
    data class NoEntry(val hash: String) : RecoverOutcome()
    data class NeedsAttention(val hash: String, val detail: String?) : RecoverOutcome()
    data class Never(val hash: String) : RecoverOutcome()
    data class Declined(val hash: String) : RecoverOutcome()
    data class Applied(val hash: String, val handshakeQuery: Map<String, String>, val waVersion: String) : RecoverOutcome()
}

private const val MAX_DETAIL = 200

/** One line out of a needs-attention placeholder's `gate`: control characters become spaces, length capped. */
fun gateDetail(gate: JsonElement?): String? {
    if (gate == null || gate.toString() == "null") return null
    val raw = if (gate is JsonPrimitive && gate.isString) gate.content else gate.toString()
    val text = raw.map { if (it.code <= 0x1f || it.code in 0x7f..0x9f) ' ' else it }.joinToString("")
    if (text.length <= MAX_DETAIL) return text
    var end = MAX_DETAIL
    if (text[end - 1].isHighSurrogate()) end--
    return text.substring(0, end) + "…"
}

/**
 * Recover an adapter for a server hash nothing built in knows: read the server's hash, look it up in
 * the catalog and (with consent) download, verify and cache the adapter file. Never throws (except
 * coroutine cancellation) and never hangs: any failure to read the page or the catalog is [RecoverOutcome.Unavailable].
 * Android applies any `ok` entry, but only its hash and handshake query.
 */
suspend fun recoverAdapter(
    roomUrl: String,
    mode: AdapterUpdates,
    ask: suspend (AdapterOffer) -> AdapterAnswer,
    onAlways: () -> Unit,
    builtinHashes: Set<String>,
    store: AdapterStore,
    client: OkHttpClient,
    indexUrl: String = DEFAULT_CATALOG_URL,
    timeoutMs: Long = CatalogClient.DEFAULT_TIMEOUT_MS,
): RecoverOutcome = try {
    withContext(Dispatchers.IO) {
        val version = ServerVersionReader.read(client, roomUrl, timeoutMs)
        val hash = version?.hash ?: return@withContext RecoverOutcome.Unavailable("could not read the server's version hash")
        if (hash in builtinHashes) return@withContext RecoverOutcome.Known(hash)
        store.load(hash)?.let { return@withContext RecoverOutcome.Known(hash, it.handshakeQuery) }

        val idx = when (val r = CatalogClient.fetchIndex(client, indexUrl, timeoutMs)) {
            is Fetched.Fail -> return@withContext RecoverOutcome.Unavailable(r.reason)
            is Fetched.Ok -> r.value
        }
        val entry = idx.entries[hash] ?: return@withContext RecoverOutcome.NoEntry(hash)
        if (entry is IndexEntry.NeedsAttention) return@withContext RecoverOutcome.NeedsAttention(hash, gateDetail(entry.gate))
        entry as IndexEntry.Ok
        if (mode == AdapterUpdates.NEVER) return@withContext RecoverOutcome.Never(hash)

        if (mode == AdapterUpdates.ASK) {
            // Fail closed: only an exact YES or ALWAYS is consent; an ask that throws is a no.
            val answer = try {
                ask(AdapterOffer(hash, version.release))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                null
            }
            if (answer != AdapterAnswer.YES && answer != AdapterAnswer.ALWAYS) return@withContext RecoverOutcome.Declined(hash)
            if (answer == AdapterAnswer.ALWAYS) {
                try { onAlways() } catch (e: Exception) { /* could not remember the choice; still applies once */ }
            }
        }

        val (file, text) = when (val r = CatalogClient.fetchAdapterFile(client, idx.url, hash, entry, timeoutMs)) {
            is Fetched.Fail -> return@withContext RecoverOutcome.Unavailable(r.reason)
            is Fetched.Ok -> r.value
        }
        store.save(hash, text)
        RecoverOutcome.Applied(hash, file.handshakeQuery, file.waVersion)
    }
} catch (e: CancellationException) {
    throw e
} catch (e: Throwable) {
    RecoverOutcome.Unavailable(e.message ?: e.javaClass.simpleName)
}
