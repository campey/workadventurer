package app.workadventurer.app.net

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class NetworkTextTest {
    private val server = ConnectionRow("Server", "Connected", upBytesPerSecond = 3_050.0, downBytesPerSecond = 150_000.0)
    private val peer = ConnectionRow("Ada", "Connected", 3_050.0, 150_000.0, rttSeconds = 0.038, jitterSeconds = 0.004, lossFraction = 0.004)

    @Test
    fun theRateLineHasUpThenDown() {
        assertEquals("↑ 24 kb/s · ↓ 1.2 Mb/s", rateLine(server))
    }

    @Test
    fun theDetailLineIsOnlyWhatTheLinkMeasured() {
        assertNull(detailLine(server))
        assertEquals("38 ms round trip · 0.4% lost · 4 ms jitter", detailLine(peer))
        assertEquals("38 ms round trip", detailLine(peer.copy(jitterSeconds = null, lossFraction = null)))
        assertEquals("0% lost", detailLine(peer.copy(rttSeconds = null, jitterSeconds = null, lossFraction = 0.0)))
    }

    @Test
    fun totalsReadUpThenDown() {
        assertEquals("↑ 1.5 KB · ↓ 34 MB", totalsLine(Totals(1536, 34L * 1024 * 1024)))
    }

    @Test
    fun aRowIsSpokenAsWordsNotArrows() {
        assertEquals(
            "Ada, Connected. Sending 24 kb/s, receiving 1.2 Mb/s. 38 ms round trip · 0.4% lost · 4 ms jitter",
            rowDescription(peer),
        )
        assertEquals("Server, Connected. Sending 24 kb/s, receiving 1.2 Mb/s", rowDescription(server))
    }
}
