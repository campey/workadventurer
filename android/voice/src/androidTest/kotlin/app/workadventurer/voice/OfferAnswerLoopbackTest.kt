package app.workadventurer.voice

import androidx.test.platform.app.InstrumentationRegistry
import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

// Run on the phone: ./gradlew :voice:connectedDebugAndroidTest
class OfferAnswerLoopbackTest {
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
}
