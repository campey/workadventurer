package app.workadventurer.voice

// THROWAWAY SPIKE (G3 step 1): does LiveKit's libwebrtc build run on the phone and produce the offer a WorkAdventure
// browser peer needs? Run on a device: ./gradlew :voice:connectedDebugAndroidTest. Not part of the product.

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import kotlin.test.Test
import kotlin.test.assertTrue

class WebRtcSpikeTest {
    private class Sdp(val onOk: (SessionDescription) -> Unit = {}, val onFail: (String) -> Unit = {}) : SdpObserver {
        override fun onCreateSuccess(d: SessionDescription) = onOk(d)
        override fun onSetSuccess() {}
        override fun onCreateFailure(e: String) = onFail("create: $e")
        override fun onSetFailure(e: String) = onFail("set: $e")
    }

    @Test
    fun theLibraryProducesAnOpusOfferWithADataChannelAndCandidates() = runBlocking {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions())
        val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        kotlinx.coroutines.delay(1500) // experiment: does the network list need time to arrive before gathering?

        val gathered = CompletableDeferred<Unit>()
        val seen = java.util.concurrent.CopyOnWriteArrayList<String>()
        val pc = factory.createPeerConnection(
            PeerConnection.RTCConfiguration(listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())),
            object : PeerConnection.Observer {
                override fun onSignalingChange(s: PeerConnection.SignalingState) {}
                override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
                override fun onIceConnectionReceivingChange(b: Boolean) {}
                override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {
                    if (s == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit)
                }
                override fun onIceCandidate(c: livekit.org.webrtc.IceCandidate) { seen += c.sdp }
                override fun onIceCandidatesRemoved(c: Array<out livekit.org.webrtc.IceCandidate>) {}
                override fun onAddStream(s: livekit.org.webrtc.MediaStream) {}
                override fun onRemoveStream(s: livekit.org.webrtc.MediaStream) {}
                override fun onDataChannel(d: DataChannel) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(r: livekit.org.webrtc.RtpReceiver, s: Array<out livekit.org.webrtc.MediaStream>) {}
            },
        )!!
        pc.createDataChannel("simplepeer", DataChannel.Init())
        val track = factory.createAudioTrack("mic", factory.createAudioSource(MediaConstraints()))
        pc.addTrack(track, listOf("stream"))

        val offer = CompletableDeferred<SessionDescription>()
        pc.createOffer(Sdp(onOk = { offer.complete(it) }, onFail = { offer.completeExceptionally(RuntimeException(it)) }), MediaConstraints())
        val created = withTimeout(10_000) { offer.await() }
        val set = CompletableDeferred<Unit>()
        pc.setLocalDescription(Sdp(onFail = { set.completeExceptionally(RuntimeException(it)) }), created)
        withTimeout(10_000) { gathered.await() }
        val sdp = pc.localDescription.description

        println("SPIKE-CANDIDATES ${seen.size}: ${seen.joinToString(" | ")}")
        println("SPIKE-SDP-BEGIN\n$sdp\nSPIKE-SDP-END")
        assertTrue("m=audio" in sdp, "no audio section")
        assertTrue("opus/48000" in sdp, "no opus")
        assertTrue("m=application" in sdp, "no data channel section")
        assertTrue("a=candidate" in sdp, "no ICE candidates after gathering")
        pc.close(); factory.dispose()
    }
}
