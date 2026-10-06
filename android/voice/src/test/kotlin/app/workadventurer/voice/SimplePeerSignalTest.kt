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

    // To learn what a browser sends when it adds a track after the first negotiation, without ever logging an SDP.
    @Test
    fun describeNamesTheShapeOfASignalButNeverItsContent() {
        assertEquals("type=renegotiate keys=[type, renegotiate]", SimplePeerSignal.describe("""{"type":"renegotiate","renegotiate":true}"""))
        assertEquals("keys=[transceiverRequest] kind=audio", SimplePeerSignal.describe("""{"transceiverRequest":{"kind":"audio","init":{"direction":"sendrecv"}}}"""))
        val offer = SimplePeerSignal.describe("""{"type":"offer","sdp":"v=0 SECRET-ICE-UFRAG"}""")
        assertEquals("type=offer keys=[type, sdp]", offer)
        assertEquals("not json", SimplePeerSignal.describe("{{{ x"))
        assertEquals("not an object", SimplePeerSignal.describe("[1]"))
    }

    @Test
    fun anOfferSerialisesInSimplePeersShape() {
        val json = SimplePeerSignal.offer("v=0\r\ns=-\r\n")
        assertEquals(PeerSignal.Offer("v=0\r\ns=-\r\n"), SimplePeerSignal.parse(json))
        assertEquals(true, json.contains("\"type\":\"offer\""))
    }

    @Test
    fun anAnswerSerialisesInSimplePeersShape() {
        val json = SimplePeerSignal.answer("v=0\r\ns=-\r\n")
        assertEquals(PeerSignal.Answer("v=0\r\ns=-\r\n"), SimplePeerSignal.parse(json))
        assertEquals(true, json.contains("\"type\":\"answer\""))
    }
}
