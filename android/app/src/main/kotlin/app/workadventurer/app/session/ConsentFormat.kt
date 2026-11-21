package app.workadventurer.app.session

import app.workadventurer.protocol.catalog.AdapterOffer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Pure formatting for the adapter-update consent dialog (JVM-testable). Everything shown is already sanitised or validated by the protocol library. */
const val CONSENT_TITLE = "Compatibility update available"
const val CONSENT_SENTENCE =
    "This server runs a version this app doesn't know yet. Only the version the app speaks to this server is changed; no code is downloaded or run."
const val CONSENT_AUTO_LABEL = "Auto-download next time"
const val CONSENT_AUTO_HELP = "Applies when you tap Download. Change this in Settings."
const val GITHUB_LINK_LABEL = "View on GitHub"
const val UNKNOWN = "unknown"

enum class ConsentRowKind { TEXT, MONO }

/** One key/value line of the dialog. [spoken] is what TalkBack reads for the merged row. */
data class ConsentRow(val label: String, val value: String, val kind: ConsentRowKind = ConsentRowKind.TEXT, val spoken: String = "$label: $value")

private val PLAIN_RELEASE = Regex("[A-Za-z0-9@._-]{1,40}")

/** The release string from the server's home page, shown only if it is plainly a version; else "unknown". */
fun releaseDisplay(release: String?): String = release?.takeIf { PLAIN_RELEASE.matches(it) } ?: UNKNOWN

/** The server's API hash as shown: monospace, verbatim (it is already validated as a hex-like token). */
fun hashDisplay(hash: String): String = hash

/** The catalog's `updated` instant as local `dd MMM HH:mm`; null if absent or unparsable. */
fun formatCatalogUpdated(iso: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String? {
    if (iso == null) return null
    return try {
        DateTimeFormatter.ofPattern("dd MMM HH:mm", locale).withZone(zone).format(Instant.parse(iso))
    } catch (e: Exception) {
        null
    }
}

/** A URL shortened for display only (scheme dropped, middle ellipsised past [max] chars). Never used to open or compare. */
fun shortUrl(url: String, max: Int = 60): String {
    val bare = url.removePrefix("https://")
    if (bare.length <= max) return bare
    val head = (max - 1) / 2
    val tail = max - 1 - head
    return bare.take(head) + "…" + bare.takeLast(tail)
}

fun consentRows(offer: AdapterOffer, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): List<ConsentRow> = buildList {
    add(ConsentRow("Server version", releaseDisplay(offer.release)))
    add(ConsentRow("Server hash", hashDisplay(offer.hash), ConsentRowKind.MONO))
    add(ConsentRow("Catalog updated", formatCatalogUpdated(offer.catalogUpdated, zone, locale) ?: UNKNOWN))
    offer.adapterUrl?.let { add(ConsentRow("Adapter file", it, ConsentRowKind.MONO, spoken = "Adapter file: ${shortUrl(it)}")) }
}

/** What Download means for the checkbox: ticked remembers the choice, unticked is a one-off yes. */
fun consentDownloadAnswer(autoNextTime: Boolean) =
    if (autoNextTime) app.workadventurer.protocol.catalog.AdapterAnswer.ALWAYS else app.workadventurer.protocol.catalog.AdapterAnswer.YES
