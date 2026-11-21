package app.workadventurer.protocol.catalog

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient

enum class AdapterUpdates { ASK, AUTO, NEVER }
enum class AdapterAnswer { YES, NO, ALWAYS }

/**
 * What the consent question is about: the server's hash and release string (e.g. `v1.35.0`), if the page had one.
 * [adapterUrl] is the https URL the library would fetch (set only when it passed the same-origin / under-directory checks) and
 * [catalogUpdated] the index's top-level `updated` instant (only if it parsed). The catalog has no per-entry date.
 */
data class AdapterOffer(val hash: String, val release: String?, val adapterUrl: String? = null, val catalogUpdated: String? = null)

sealed class RecoverOutcome {
    /** [reason] is sanitised (no control/format characters, capped). */
    data class Unavailable(val reason: String) : RecoverOutcome()
    /** A built-in adapter or a loadable cached file covers this hash; [handshakeQuery] is the cached file's (empty for built-ins). */
    data class Known(val hash: String, val handshakeQuery: Map<String, String> = emptyMap()) : RecoverOutcome()
    data class NoEntry(val hash: String) : RecoverOutcome()
    data class NeedsAttention(val hash: String, val detail: String?) : RecoverOutcome()
    data class Never(val hash: String) : RecoverOutcome()
    data class Declined(val hash: String) : RecoverOutcome()
    data class Applied(val hash: String, val handshakeQuery: Map<String, String>, val waVersion: String) : RecoverOutcome()
}

/** One line out of a needs-attention placeholder's `gate` (a string or an object summary), sanitised and capped. */
fun gateDetail(gate: JsonElement?): String? {
    if (gate == null || gate.toString() == "null") return null
    return sanitizeText(if (gate is JsonPrimitive && gate.isString) gate.content else gate.toString())
}

private fun unavailable(reason: String) = RecoverOutcome.Unavailable(sanitizeText(reason))

/**
 * Recover an adapter for a server hash nothing built in knows: read the server's hash, look it up in
 * the catalog and (with consent) download, verify and cache the adapter file. Never throws (except
 * coroutine cancellation, which also cancels the in-flight HTTP call and stops before any download or
 * cache write) and never hangs: any failure to read the page or the catalog is [RecoverOutcome.Unavailable].
 * Android applies any `ok` entry, but only its hash and handshake query.
 *
 * [ask] runs on the caller's dispatcher (it may show UI); only exact YES / ALWAYS is consent.
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
    val version = ServerVersionReader.read(client, roomUrl, timeoutMs)
    val hash = version?.hash
    if (hash == null) {
        unavailable("could not read the server's version hash")
    } else if (hash in builtinHashes) {
        RecoverOutcome.Known(hash)
    } else {
        val cached = withContext(Dispatchers.IO) { store.load(hash) }
        if (cached != null) RecoverOutcome.Known(hash, cached.handshakeQuery) else recoverFromCatalog(
            hash, version.release, mode, ask, onAlways, store, client, indexUrl, timeoutMs,
        )
    }
} catch (e: CancellationException) {
    throw e
} catch (e: Throwable) {
    unavailable(e.message ?: e.javaClass.simpleName)
}

private suspend fun recoverFromCatalog(
    hash: String, release: String?, mode: AdapterUpdates, ask: suspend (AdapterOffer) -> AdapterAnswer, onAlways: () -> Unit,
    store: AdapterStore, client: OkHttpClient, indexUrl: String, timeoutMs: Long,
): RecoverOutcome {
    val idx = when (val r = CatalogClient.fetchIndex(client, indexUrl, timeoutMs)) {
        is Fetched.Fail -> return unavailable(r.reason)
        is Fetched.Ok -> r.value
    }
    val entry = idx.entries[hash] ?: return RecoverOutcome.NoEntry(hash)
    if (entry is IndexEntry.NeedsAttention) return RecoverOutcome.NeedsAttention(hash, gateDetail(entry.gate))
    entry as IndexEntry.Ok
    if (mode == AdapterUpdates.NEVER) return RecoverOutcome.Never(hash)

    if (mode == AdapterUpdates.ASK) {
        // Fail closed: only an exact YES or ALWAYS is consent; an ask that throws is a no.
        val answer = try {
            ask(AdapterOffer(hash, release, CatalogClient.displayAdapterUrl(idx.url, entry), idx.updated))
        } catch (e: CancellationException) {
            // Our own cancellation propagates; a CancellationException thrown by the ask itself (e.g. a timeout) is a no.
            if (!currentCoroutineContext().isActive) throw e
            null
        } catch (e: Throwable) {
            null
        }
        if (answer != AdapterAnswer.YES && answer != AdapterAnswer.ALWAYS) return RecoverOutcome.Declined(hash)
        if (answer == AdapterAnswer.ALWAYS) {
            try { onAlways() } catch (e: Exception) { /* could not remember the choice; still applies once */ }
        }
    }

    currentCoroutineContext().ensureActive()
    val (file, text) = when (val r = CatalogClient.fetchAdapterFile(client, idx.url, hash, entry, timeoutMs)) {
        is Fetched.Fail -> return unavailable(r.reason)
        is Fetched.Ok -> r.value
    }
    currentCoroutineContext().ensureActive()
    withContext(Dispatchers.IO) { store.save(hash, text) }
    return RecoverOutcome.Applied(hash, file.handshakeQuery, file.waVersion)
}
