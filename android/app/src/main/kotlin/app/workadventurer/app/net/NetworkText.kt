package app.workadventurer.app.net

const val NETWORK_SHEET_TITLE = "Network"
const val NETWORK_BUTTON_DESCRIPTION = "Network: connections and data used"

/** `↑ 24 kb/s · ↓ 1.2 Mb/s`: what this connection sends, then what it receives. */
fun rateLine(r: ConnectionRow) = "↑ ${formatRate(r.upBytesPerSecond)} · ↓ ${formatRate(r.downBytesPerSecond)}"

/** What a call link has measured (round trip, loss, jitter), or null for a connection with none (the server socket). */
fun detailLine(r: ConnectionRow): String? =
    listOfNotNull(
        r.rttSeconds?.let { "${formatMs(it)} round trip" },
        r.lossFraction?.let { "${formatPercent(it)} lost" },
        r.jitterSeconds?.let { "${formatMs(it)} jitter" },
    ).takeIf { it.isNotEmpty() }?.joinToString(" · ")

fun totalsLine(t: Totals) = "↑ ${formatBytes(t.up)} · ↓ ${formatBytes(t.down)}"

/** The row for a screen reader: words, not arrows. */
fun rowDescription(r: ConnectionRow): String =
    "${r.label}, ${r.state}. Sending ${formatRate(r.upBytesPerSecond)}, receiving ${formatRate(r.downBytesPerSecond)}" +
        (detailLine(r)?.let { ". $it" } ?: "")
