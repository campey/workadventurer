package app.workadventurer.voice

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SdpShapeTest {
    private val offer = listOf(
        "v=0",
        "o=- 4611731400430051336 2 IN IP4 203.0.113.9",
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0 1",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
        "c=IN IP4 203.0.113.9",
        "a=candidate:1 1 udp 2113937151 203.0.113.9 51234 typ host",
        "a=ice-ufrag:abcd",
        "a=ice-pwd:secretsecretsecret",
        "a=fingerprint:sha-256 AA:BB:CC",
        "a=setup:actpass",
        "a=mid:0",
        "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
        "a=sendrecv",
        "a=rtpmap:111 opus/48000/2",
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "a=rtpmap:96 VP8/90000",
        "a=inactive",
    ).joinToString("\r\n") + "\r\n"

    @Test
    fun keepsTheMediaSectionsCodecsAndExtensionsThatDecideWhetherAnOfferParses() {
        val shape = sdpShape(offer)
        assertTrue("m=audio 9 UDP/TLS/RTP/SAVPF 111 63" in shape)
        assertTrue("a=rtpmap:111 opus/48000/2" in shape)
        assertTrue("a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level" in shape)
        assertTrue("a=group:BUNDLE 0 1" in shape)
        assertTrue("m=video 9 UDP/TLS/RTP/SAVPF 96" in shape)
    }

    @Test
    fun neverKeepsAddressesCandidatesOrKeys() {
        val shape = sdpShape(offer)
        assertFalse("203.0.113.9" in shape)
        assertFalse("candidate" in shape)
        assertFalse("ice-pwd" in shape || "secretsecret" in shape)
        assertFalse("fingerprint" in shape)
        assertFalse("ice-ufrag" in shape)
    }

    @Test
    fun saysHowBigTheOfferWasAndSurvivesNonsense() {
        assertEquals("sdp 0 bytes, 0 lines", sdpShape(""))
        assertTrue(sdpShape(offer).startsWith("sdp ${offer.length} bytes, 19 lines"))
        assertTrue(sdpShape("not sdp at all").startsWith("sdp 14 bytes, 1 lines"))
    }
}
