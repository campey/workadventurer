package app.workadventurer.app.net

import app.workadventurer.voice.LinkStats
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class NetworkTableTest {
    private fun link(sent: Long, received: Long, lost: Long = 0, packets: Long = 100, rtt: Double? = 0.04, jitter: Double? = 0.01, state: String = "connected") =
        LinkStats(state, sent, received, packets, lost, jitter, rtt)

    @Test
    fun theServerComesFirstThenPeersByName() {
        val t = NetworkTable()
        val rows = t.build(0, ServerReading(true, 0, 0), listOf(PeerReading("b", "Zed", link(0, 0)), PeerReading("a", "Ada", link(0, 0))))
        assertEquals(listOf("Server", "Ada", "Zed"), rows.map { it.label })
    }

    @Test
    fun ratesComeFromTwoReadingsAndTheFirstIsZero() {
        val t = NetworkTable()
        val first = t.build(0, ServerReading(true, bytesOut = 1_000, bytesIn = 4_000), listOf(PeerReading("a", "Ada", link(sent = 10_000, received = 20_000))))
        assertEquals(listOf(0.0, 0.0), first.map { it.upBytesPerSecond })
        val second = t.build(2_000, ServerReading(true, bytesOut = 3_000, bytesIn = 10_000), listOf(PeerReading("a", "Ada", link(sent = 14_000, received = 30_000))))
        assertEquals(1_000.0, second[0].upBytesPerSecond); assertEquals(3_000.0, second[0].downBytesPerSecond)
        assertEquals(2_000.0, second[1].upBytesPerSecond); assertEquals(5_000.0, second[1].downBytesPerSecond)
    }

    @Test
    fun callLinksCarryTheirRoundTripJitterAndLossWhileTheServerHasNone() {
        val rows = NetworkTable().build(0, ServerReading(true, 0, 0), listOf(PeerReading("a", "Ada", link(0, 0, lost = 1, packets = 99, rtt = 0.038, jitter = 0.004))))
        assertNull(rows[0].rttSeconds); assertNull(rows[0].lossFraction); assertNull(rows[0].jitterSeconds)
        assertEquals(0.038, rows[1].rttSeconds); assertEquals(0.004, rows[1].jitterSeconds)
        assertEquals(0.01, rows[1].lossFraction) // 1 lost of 100 expected
    }

    @Test
    fun lossIsUnknownBeforeAnyPacketHasBeenExpected() {
        val rows = NetworkTable().build(0, ServerReading(true, 0, 0), listOf(PeerReading("a", "Ada", link(0, 0, lost = 0, packets = 0))))
        assertNull(rows[1].lossFraction)
    }

    @Test
    fun theStateReadsPlainly() {
        val rows = NetworkTable().build(0, ServerReading(false, 0, 0), listOf(PeerReading("a", "Ada", link(0, 0, state = "connecting"))))
        assertEquals(listOf("Not connected", "Connecting"), rows.map { it.state })
        assertEquals("Connected", NetworkTable().build(0, ServerReading(true, 0, 0), emptyList())[0].state)
    }

    @Test
    fun aPeerWhoLeavesAndComesBackStartsFromZeroRatherThanAHugeJump() {
        val t = NetworkTable()
        t.build(0, ServerReading(true, 0, 0), listOf(PeerReading("a", "Ada", link(1_000, 1_000))))
        t.build(1_000, ServerReading(true, 0, 0), emptyList())
        val back = t.build(2_000, ServerReading(true, 0, 0), listOf(PeerReading("a", "Ada", link(500_000, 500_000))))
        assertEquals(0.0, back[1].upBytesPerSecond)
    }

    @Test
    fun nothingIsShownAsAPeerNamedNothing() {
        val rows = NetworkTable().build(0, ServerReading(true, 0, 0), listOf(PeerReading("a", "", link(0, 0))))
        assertEquals("Someone", rows[1].label)
    }
}
