package app.workadventurer.voice

import androidx.test.platform.app.InstrumentationRegistry
import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

// Run on the phone: ./gradlew :voice:connectedDebugAndroidTest
class AnswerRealBrowserOfferTest {
    // The exact offer a real WorkAdventure browser peer sent (m=video first, then audio, then the data channel). werift
    // threw on its video section; libwebrtc must answer it.
    @Test
    fun answersTheCapturedRealBrowserOffer() = runBlocking {
        val inst = InstrumentationRegistry.getInstrumentation()
        val offer = inst.context.assets.open("live-browser-offer-with-video.sdp").bufferedReader().readText()
        val engine = VoiceEngine(inst.targetContext)
        try {
            val link = engine.newLink("c1", listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null)))
            val answer = withTimeout(15_000) { link.acceptOffer(offer) }
            assertNotNull(answer, "no usable answer")
            println("ANSWER-SDP-BEGIN\n$answer\nANSWER-SDP-END")
            assertTrue(Regex("m=audio [1-9]").containsMatchIn(answer), "audio section not accepted")
            assertTrue("opus/48000" in answer)
            // When the phone answers a browser it must also SEND: a receive-only audio answer means the browser shows our mic as
            // on (we announce it) while no audio ever arrives, i.e. a red mic, and mute/unmute change nothing it can hear.
            val audio = answer.split(Regex("(?m)^(?=m=)")).first { it.startsWith("m=audio") }
            assertTrue("a=sendrecv" in audio, "the audio answer must be sendrecv, was: ${audio.lines().filter { it.startsWith("a=") && ("only" in it || "send" in it || "inactive" in it) }}")
            // libwebrtc keeps the video section (the m-line order must match the offer) but we never show video, so it must be
            // INACTIVE: a recvonly answer would have a browser peer with its camera on stream video to a backgrounded phone.
            val video = answer.split(Regex("(?m)^(?=m=)")).firstOrNull { it.startsWith("m=video") }
            assertNotNull(video, "no video section in the answer: the m-line order must match the offer")
            assertTrue("a=inactive" in video, "the video section must be inactive, was: ${video.lines().filter { it.startsWith("a=") && it.contains("only") || it.startsWith("a=send") || it.startsWith("a=inactive") }}")
            assertTrue(Regex("m=application [1-9]").containsMatchIn(answer), "data channel not accepted")
            assertTrue("a=candidate" in answer, "answer has no ICE candidates")
            link.close()
        } finally { engine.close() }
    }
}
