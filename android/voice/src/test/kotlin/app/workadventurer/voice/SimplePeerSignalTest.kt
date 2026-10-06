package app.workadventurer.voice

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SimplePeerSignalTest {
    @Test
    fun parsesAnOfferAndAnAnswer() {
        assertEquals(PeerSignal.Offer("v=0\r\n"), SimplePeerSignal.parse("""{"type":"offer","sdp":"v=0\r\n"}"""))
        assertEquals(PeerSignal.Answer("x"), SimplePeerSignal.parse("""{"type":"answer","sdp":"x"}"""))
    }

    @Test
    fun parsesATrickleCandidate() {
        val s = SimplePeerSignal.parse("""{"type":"candidate","candidate":{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"1","sdpMLineIndex":1}}""")
        assertEquals(PeerSignal.Candidate("candidate:1 1 udp 1 1.2.3.4 5 typ host", "1", 1), s)
    }

    // Review Focus 5: nothing we don't understand may throw.
    @Test
    fun ignoresRenegotiateUnknownAndGarbage() {
        assertNull(SimplePeerSignal.parse("""{"type":"renegotiate"}"""))
        assertNull(SimplePeerSignal.parse("""{"transceiverRequest":{"kind":"video"}}"""))
        assertNull(SimplePeerSignal.parse("""{"type":"offer"}""")) // no sdp
        assertNull(SimplePeerSignal.parse("{{{ not json"))
        assertNull(SimplePeerSignal.parse(""))
        assertNull(SimplePeerSignal.parse("""[1,2,3]"""))
        assertNull(SimplePeerSignal.parse("""{"type":"candidate","candidate":"not an object"}"""))
    }

    @Test
    fun anAnswerSerialisesInSimplePeersShape() {
        val json = SimplePeerSignal.answer("v=0\r\ns=-\r\n")
        assertEquals(PeerSignal.Answer("v=0\r\ns=-\r\n"), SimplePeerSignal.parse(json))
        assertEquals(true, json.contains("\"type\":\"answer\""))
    }
}
