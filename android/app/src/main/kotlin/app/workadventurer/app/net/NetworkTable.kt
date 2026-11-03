package app.workadventurer.app.net

import app.workadventurer.voice.LinkStats

/** The server socket's running byte counts. */
data class ServerReading(val connected: Boolean, val bytesOut: Long, val bytesIn: Long)

/** A call link's counters with the name of the person at the other end (never an id). */
data class PeerReading(val key: String, val name: String, val stats: LinkStats)

/** One line of the Network sheet. The times and the loss are null where the link has no such measure (the server socket has none). */
data class ConnectionRow(
    val label: String,
    val state: String,
    val upBytesPerSecond: Double,
    val downBytesPerSecond: Double,
    val rttSeconds: Double? = null,
    val jitterSeconds: Double? = null,
    val lossFraction: Double? = null,
)

/** What the Network sheet shows: the open connections, and what has been used. */
data class NetSnapshot(val connections: List<ConnectionRow> = emptyList(), val session: Totals = Totals(0, 0), val allTime: Totals = Totals(0, 0))

/** Turns raw readings into rows, keeping a rate meter per connection between readings. Pure: the caller supplies the clock. */
class NetworkTable {
    private val meters = HashMap<String, Pair<RateMeter, RateMeter>>()

    fun build(nowMs: Long, server: ServerReading, peers: List<PeerReading>): List<ConnectionRow> {
        val keys = setOf(SERVER_KEY) + peers.map { it.key }
        meters.keys.retainAll(keys) // a link that went away starts from zero if it comes back
        val rows = mutableListOf(
            row(SERVER_KEY, "Server", if (server.connected) "Connected" else "Not connected", server.bytesOut, server.bytesIn, nowMs),
        )
        peers.sortedBy { it.name.ifBlank { UNNAMED }.lowercase() }.forEach { p ->
            val st = p.stats
            val expected = st.packetsReceived + st.packetsLost
            rows += row(p.key, p.name.ifBlank { UNNAMED }, st.state.replaceFirstChar { it.uppercase() }, st.bytesSent, st.bytesReceived, nowMs)
                .copy(rttSeconds = st.rttSeconds, jitterSeconds = st.jitterSeconds, lossFraction = if (expected > 0) st.packetsLost.toDouble() / expected else null)
        }
        return rows
    }

    private fun row(key: String, label: String, state: String, out: Long, `in`: Long, nowMs: Long): ConnectionRow {
        val (up, down) = meters.getOrPut(key) { RateMeter() to RateMeter() }
        return ConnectionRow(label, state, up.sample(out, nowMs), down.sample(`in`, nowMs))
    }

    private companion object { const val SERVER_KEY = "\u0000server"; const val UNNAMED = "Someone" }
}
