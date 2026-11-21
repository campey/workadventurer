package app.workadventurer.app.session

import app.workadventurer.protocol.catalog.AdapterAnswer
import app.workadventurer.protocol.catalog.AdapterOffer
import app.workadventurer.protocol.catalog.AdapterStore
import app.workadventurer.protocol.catalog.AdapterUpdates
import app.workadventurer.protocol.catalog.DEFAULT_CATALOG_URL
import app.workadventurer.protocol.catalog.RecoverOutcome
import app.workadventurer.protocol.catalog.recoverAdapter
import app.workadventurer.protocol.Wa133
import app.workadventurer.protocol.WaStaging
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/**
 * What [WaSession] asks for when a server refuses our API version hash (a typed NEW_VERSION refusal): find an adapter for
 * the server's version. A port, so the session tests on the JVM with a fake. [ask] is the consent question; the session
 * turns it into the dialog. Implementations never throw (except cancellation).
 */
fun interface AdapterRecovery {
    suspend fun recover(roomUrl: String, ask: suspend (AdapterOffer) -> AdapterAnswer): RecoverOutcome
}

/** Where the "adapter updates" preference lives (SharedPreferences in the app, memory in tests). */
interface AdapterSettings {
    var updates: AdapterUpdates
}

/**
 * The production [AdapterRecovery]: reads the preference at call time, runs [recoverAdapter] off the caller's thread (the JSON parse,
 * meta scan and sha256 would otherwise run on the session's dispatcher) and remembers "Don't ask again" as `auto`.
 * [run] is [recoverAdapter] unless a test swaps it.
 */
class CatalogAdapterRecovery(
    private val settings: AdapterSettings,
    private val store: AdapterStore,
    private val client: OkHttpClient,
    private val indexUrl: String = DEFAULT_CATALOG_URL,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val run: suspend (
        roomUrl: String, mode: AdapterUpdates, ask: suspend (AdapterOffer) -> AdapterAnswer, onAlways: () -> Unit,
    ) -> RecoverOutcome = { roomUrl, mode, ask, onAlways ->
        recoverAdapter(
            roomUrl, mode, ask, onAlways,
            builtinHashes = BUILTIN_HASHES, store = store, client = client, indexUrl = indexUrl,
        )
    },
) : AdapterRecovery {
    override suspend fun recover(roomUrl: String, ask: suspend (AdapterOffer) -> AdapterAnswer): RecoverOutcome =
        withContext(dispatcher) {
            run(roomUrl, settings.updates, ask, { settings.updates = AdapterUpdates.AUTO })
        }

    companion object {
        val BUILTIN_HASHES: Set<String> = (Wa133.API_VERSION_HASHES + WaStaging.API_VERSION_HASH).toSet()
    }
}

/** What the user reads when the server refused our version and recovery did not produce a retry. Never includes unsanitised catalog text. */
fun recoveryFailureMessage(outcome: RecoverOutcome, original: String): String = when (outcome) {
    is RecoverOutcome.Unavailable ->
        "This server runs a newer version than this app supports, and the app couldn't check for updates right now. Try again later."
    is RecoverOutcome.NoEntry ->
        "There is no adapter for this server version yet, so the app can't join it. It will work once an adapter is published."
    is RecoverOutcome.NeedsAttention ->
        "This server version isn't supported yet: it needs attention from the maintainers." +
            (outcome.detail?.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: "")
    is RecoverOutcome.Never ->
        "This server runs a newer version than this app supports. Adapter updates are turned off in Settings."
    is RecoverOutcome.Declined ->
        "This server runs a newer version than this app supports, and the adapter update wasn't downloaded."
    // Known/Applied that did not help (or could not be applied): the server's own message is the honest one.
    is RecoverOutcome.Known, is RecoverOutcome.Applied -> original
}

/** The consent dialog's text. The release string comes from the server's home page: shown only if it is plainly a version. */
fun consentMessage(offer: AdapterOffer): String {
    val release = offer.release?.takeIf { Regex("[A-Za-z0-9@._-]{1,40}").matches(it) }
    val which = if (release != null) "version $release" else "a newer version"
    return "This server runs $which of WorkAdventure, which this app doesn't know yet. " +
        "Download a small compatibility update from the app's public catalog? Only the version it speaks is changed."
}
