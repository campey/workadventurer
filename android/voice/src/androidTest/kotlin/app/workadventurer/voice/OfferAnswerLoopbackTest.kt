package app.workadventurer.voice

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Rule
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

// Run on the phone: ./gradlew :voice:connectedDebugAndroidTest
class OfferAnswerLoopbackTest {
    @get:Rule val mic: GrantPermissionRule = GrantPermissionRule.grant(android.Manifest.permission.RECORD_AUDIO)

    // Our offerer and our answerer, in one process, exchanging full non-trickle SDPs the way the mesh does over the server.
    @Test
    fun anOffererAndAnAnswererNegotiateAndConnect() = runBlocking {
        val engine = VoiceEngine(InstrumentationRegistry.getInstrumentation().targetContext)
        try {
            val ice = listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null))
            val offerer = engine.newLink("c1", ice) as WebRtcPeerLink
            val answerer = engine.newLink("c1", ice) as WebRtcPeerLink
            val offer = withTimeout(15_000) { offerer.createOffer() }
            assertNotNull(offer, "no usable offer")
            assertTrue("m=application" in offer, "the offer must carry the simplepeer data channel")
            val answer = withTimeout(15_000) { answerer.acceptOffer(offer) }
            assertNotNull(answer, "no usable answer")
            offerer.acceptAnswer(answer)
            assertTrue(offerer.awaitConnected(15_000), "the offerer never connected")
            assertTrue(answerer.awaitConnected(15_000), "the answerer never connected")
            offerer.close(); answerer.close()
        } finally { engine.close() }
    }

    // M3: with the mic unmuted, real audio packets flow in both directions between our own offerer and answerer, and muting
    // flips the engine without crashing. (The red-mic fix relies on RTP flowing continuously from a live track.)
    @Test
    fun anUnmutedMicSendsAudioPacketsBothWays() = runBlocking {
        val engine = VoiceEngine(InstrumentationRegistry.getInstrumentation().targetContext)
        try {
            engine.setMuted(false)
            val ice = listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null))
            val offerer = engine.newLink("c1", ice) as WebRtcPeerLink
            val answerer = engine.newLink("c1", ice) as WebRtcPeerLink
            val offer = withTimeout(15_000) { offerer.createOffer() }!!
            assertTrue("a=sendrecv" in offer || "a=sendonly" in offer, "the offer must carry our audio track, not be receive-only")
            val answer = withTimeout(15_000) { answerer.acceptOffer(offer) }!!
            offerer.acceptAnswer(answer)
            assertTrue(offerer.awaitConnected(15_000) && answerer.awaitConnected(15_000))
            delay(2_500)
            assertTrue(offerer.audioPacketsSent() > 30, "offerer sent ${offerer.audioPacketsSent()} packets")
            assertTrue(answerer.audioPacketsReceived() > 30, "answerer received ${answerer.audioPacketsReceived()} packets")
            assertTrue(answerer.audioPacketsSent() > 30, "answerer sent ${answerer.audioPacketsSent()} packets")
            assertTrue(offerer.audioPacketsReceived() > 30, "offerer received ${offerer.audioPacketsReceived()} packets")
            engine.setMuted(true); engine.setMuted(false)
            offerer.close(); answerer.close()
        } finally { engine.close() }
    }
}
