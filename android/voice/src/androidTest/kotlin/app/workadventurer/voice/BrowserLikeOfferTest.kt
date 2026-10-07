package app.workadventurer.voice

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.MediaStreamTrack
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import org.junit.Rule
import kotlin.test.Test
import kotlin.test.assertTrue

// Run on the phone: ./gradlew :voice:connectedDebugAndroidTest
//
// Every earlier media test had the phone OFFERING. Answering a real browser (video section first, then audio, then the data
// channel, as in test/fixtures/live-browser-offer-with-video.sdp) with media actually flowing was never run end to end after we
// made the answer's video section inactive; live, an area meeting showed ICE connected but 0 audio packets either way.
class BrowserLikeOfferTest {
    @get:Rule val mic: GrantPermissionRule = GrantPermissionRule.grant(android.Manifest.permission.RECORD_AUDIO)

    /** A raw libwebrtc peer that makes the same shape of offer a browser does: video, audio (with a track), data channel. */
    private class BrowserLike(engine: VoiceEngine) {
        private val connected = CompletableDeferred<Unit>()
        private val firstCandidate = CompletableDeferred<Unit>()
        val pc: PeerConnection = engine.factory.createPeerConnection(
            PeerConnection.RTCConfiguration(listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()))
                .apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN },
            object : PeerConnection.Observer {
                override fun onSignalingChange(s: PeerConnection.SignalingState) {}
                override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {
                    if (s == PeerConnection.IceConnectionState.CONNECTED || s == PeerConnection.IceConnectionState.COMPLETED) connected.complete(Unit)
                }
                override fun onIceConnectionReceivingChange(b: Boolean) {}
                override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
                override fun onIceCandidate(c: IceCandidate) { firstCandidate.complete(Unit) }
                override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
                override fun onAddStream(s: MediaStream) {}
                override fun onRemoveStream(s: MediaStream) {}
                override fun onDataChannel(d: DataChannel) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
            },
        )!!
        private val track = engine.micTrack

        private class Set(val done: CompletableDeferred<Unit>) : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) {}
            override fun onSetSuccess() { done.complete(Unit) }
            override fun onCreateFailure(e: String) { done.completeExceptionally(IllegalStateException(e)) }
            override fun onSetFailure(e: String) { done.completeExceptionally(IllegalStateException(e)) }
        }

        /** [withAudio] false is a browser that joined muted: no audio track yet, so its first offer has nothing to say about audio. */
        suspend fun createOffer(withAudio: Boolean = true): String {
            // video first (mid 0), then audio, then the data channel: the browser's m-line order
            pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY))
            if (withAudio) pc.addTrack(track, listOf("browser-stream"))
            pc.createDataChannel("simplepeer", DataChannel.Init())
            return offerNow()
        }

        /** The user unmutes: the track is added to the existing connection and the browser offers again. */
        suspend fun renegotiateWithAudio(): String {
            pc.addTrack(track, listOf("browser-stream"))
            return offerNow()
        }

        private suspend fun offerNow(): String {
            val created = CompletableDeferred<SessionDescription>()
            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(d: SessionDescription) { created.complete(d) }
                override fun onSetSuccess() {}
                override fun onCreateFailure(e: String) { created.completeExceptionally(IllegalStateException(e)) }
                override fun onSetFailure(e: String) {}
            }, MediaConstraints())
            val set = CompletableDeferred<Unit>()
            pc.setLocalDescription(Set(set), created.await())
            set.await()
            withTimeout(5_000) { firstCandidate.await() }
            delay(1_000) // let the reflexive candidate arrive too
            return pc.localDescription.description
        }

        suspend fun acceptAnswer(sdp: String) {
            val set = CompletableDeferred<Unit>()
            pc.setRemoteDescription(Set(set), SessionDescription(SessionDescription.Type.ANSWER, sdp))
            set.await()
        }

        suspend fun awaitConnected(ms: Long) = withTimeoutOrNull(ms) { connected.await() } != null

        suspend fun inboundAudioPackets(): Long {
            val out = CompletableDeferred<Long>()
            pc.getStats { r -> out.complete((r.statsMap.values.firstOrNull { it.type == "inbound-rtp" && it.members["kind"] == "audio" }?.members?.get("packetsReceived") as? Number)?.toLong() ?: 0L) }
            return withTimeoutOrNull(3_000) { out.await() } ?: 0L
        }
    }

    // The live bug: a browser that joined MUTED made a first offer without audio; when the user unmuted it offered again on the same
    // connection, our answer path tried to add the microphone a second time ("addTrack failed"), tore the link down, and the
    // browser showed a red mic and unresponsive mute until the server restarted the connection about 16 s later.
    @Test
    fun aBrowserThatJoinedMutedAndLaterAddsAudioIsHeardWithoutTheLinkBreaking() = runBlocking {
        val engine = VoiceEngine(InstrumentationRegistry.getInstrumentation().targetContext)
        try {
            engine.setMuted(false)
            val ice = listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null))
            val phone = engine.newLink("c1", ice) as WebRtcPeerLink
            val browser = BrowserLike(engine)
            val first = browser.createOffer(withAudio = false)
            browser.acceptAnswer(withTimeout(15_000) { phone.acceptOffer(first) }!!)
            assertTrue(browser.awaitConnected(15_000) && phone.awaitConnected(15_000), "no connection after the audio-less first offer")

            val second = browser.renegotiateWithAudio() // the user unmutes
            val answer = withTimeout(15_000) { phone.acceptOffer(second) }
            assertTrue(answer != null, "the second offer must be answered, not break the link")
            browser.acceptAnswer(answer!!)
            delay(3_000)
            val summary = phone.statsSummary()
            assertTrue(phone.audioPacketsReceived() > 30, "the phone never heard the browser after it unmuted: $summary")
            assertTrue(browser.inboundAudioPackets() > 30, "the browser never heard the phone: $summary")
            phone.close(); browser.pc.close()
        } finally { engine.close() }
    }

    @Test
    fun answeringABrowserLikeOfferWithVideoFirstConnectsAndCarriesAudioBothWays() = runBlocking {
        val engine = VoiceEngine(InstrumentationRegistry.getInstrumentation().targetContext)
        try {
            engine.setMuted(false)
            val ice = listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null))
            val phone = engine.newLink("c1", ice) as WebRtcPeerLink
            val browser = BrowserLike(engine)
            val offer = browser.createOffer()
            assertTrue(offer.indexOf("m=video") < offer.indexOf("m=audio"), "the test offer must have video first, like a browser's")
            val answer = withTimeout(15_000) { phone.acceptOffer(offer) }!!
            browser.acceptAnswer(answer)
            assertTrue(browser.awaitConnected(15_000), "the browser-like peer never connected")
            assertTrue(phone.awaitConnected(15_000), "the phone never connected")
            delay(3_000)
            val summary = phone.statsSummary()
            assertTrue(phone.audioPacketsSent() > 30, "the phone sent no audio to the browser: $summary")
            assertTrue(browser.inboundAudioPackets() > 30, "the browser received no audio from the phone: $summary")
            assertTrue(phone.audioPacketsReceived() > 30, "the phone received no audio from the browser: $summary")
            phone.close(); browser.pc.close()
        } finally { engine.close() }
    }
}
