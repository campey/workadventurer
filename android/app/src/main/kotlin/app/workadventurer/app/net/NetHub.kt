package app.workadventurer.app.net

import app.workadventurer.protocol.PusherConnection
import app.workadventurer.voice.PeerStats
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Collects what the Network sheet shows: the server socket's byte counts, the call links' numbers (from the mesh, only while the sheet
 * is open), and the app's running traffic totals. Platform glue around the tested [NetworkTable] and [UsageTotals]; verified on the phone.
 * [traffic] is the device's running (sent, received) byte counters for this app.
 */
class NetHub(
    private val usage: UsageTotals,
    private val traffic: () -> Pair<Long, Long>,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val table = NetworkTable()
    private val _snapshot = MutableStateFlow(NetSnapshot(session = usage.session, allTime = usage.allTime))
    val snapshot: StateFlow<NetSnapshot> = _snapshot.asStateFlow()

    /** True while the sheet is open: the call links are only read then (it costs a getStats per link), and the ticker speeds up. */
    @Volatile var wanted = false

    @Volatile private var conn: PusherConnection? = null
    @Volatile private var peers: List<PeerStats> = emptyList()

    /** The connection the call links belong to (the server row and the names come from it); null when the call is over. */
    fun attach(c: PusherConnection?) { conn = c; if (c == null) peers = emptyList() }

    /** The mesh's latest reading of its links. */
    fun peerStats(list: List<PeerStats>) { peers = list }

    /** A new join: the session's totals start from now. */
    @Synchronized fun startSession() {
        val (up, down) = traffic()
        usage.startSession(up, down)
        publish()
    }

    /** Called regularly: adds the traffic since the last call to the totals, and refreshes the sheet's numbers. */
    @Synchronized fun tick() {
        val (up, down) = traffic()
        usage.update(up, down)
        publish()
    }

    @Synchronized fun resetAllTime() { usage.resetAllTime(); publish() }

    private fun publish() {
        val c = conn
        val names = c?.state?.spaceUserNames?.value.orEmpty()
        val rows = table.build(
            now(), ServerReading(c != null, c?.bytesOut ?: 0, c?.bytesIn ?: 0),
            peers.map { PeerReading(it.peer, names[it.peer].orEmpty(), it.stats) },
        )
        _snapshot.value = NetSnapshot(rows, usage.session, usage.allTime)
    }
}
