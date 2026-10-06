package app.workadventurer.voice

import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import java.util.concurrent.atomic.AtomicInteger

/** One simple-peer connection, as answerer or offerer. Remote audio plays through the audio device module on its own. */
internal class WebRtcPeerLink(
    factory: PeerConnectionFactory,
    private val connectionId: String,
    iceServers: List<IceServerInfo>,
) : PeerLink {
    private val gate = CandidateGate() // when a non-trickle SDP has its candidates; see CandidateGate
    private val keepAlive = mutableListOf<Any>() // data channel references: libwebrtc drops channels nobody holds
    private val connected = CompletableDeferred<Unit>()

    private val pc: PeerConnection = factory.createPeerConnection(
        PeerConnection.RTCConfiguration(iceServers.map {
            PeerConnection.IceServer.builder(it.urls).apply { it.username?.let(::setUsername); it.credential?.let(::setPassword) }.createIceServer()
        }).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN },
        object : PeerConnection.Observer {
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {
                if (s == PeerConnection.IceConnectionState.CONNECTED || s == PeerConnection.IceConnectionState.COMPLETED) connected.complete(Unit)
            }
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {
                if (s == PeerConnection.IceGatheringState.COMPLETE) gate.onComplete()
            }
            override fun onIceCandidate(c: IceCandidate) { gate.onCandidate() }
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
            override fun onAddStream(s: MediaStream) {}
            override fun onRemoveStream(s: MediaStream) {}
            override fun onDataChannel(d: DataChannel) { synchronized(keepAlive) { keepAlive += d } }
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
        },
    ) ?: error("createPeerConnection returned null")

    /** Completes [done] when a set-description call succeeds, fails it otherwise. */
    private class SetObserver(private val done: CompletableDeferred<Unit>) : SdpObserver {
        override fun onCreateSuccess(d: SessionDescription) {}
        override fun onSetSuccess() { done.complete(Unit) }
        override fun onCreateFailure(e: String) { done.completeExceptionally(IllegalStateException("create: $e")) }
        override fun onSetFailure(e: String) { done.completeExceptionally(IllegalStateException("set: $e")) }
    }

    override suspend fun acceptOffer(offerSdp: String): String? {
        val remoteSet = CompletableDeferred<Unit>()
        pc.setRemoteDescription(SetObserver(remoteSet), SessionDescription(SessionDescription.Type.OFFER, offerSdp))
        remoteSet.await()

        // A browser offer always carries a video section. We keep it (the answer's m-line order must match) but never show
        // video, so make it inactive: left recvonly, a peer with its camera on would stream video to a backgrounded phone.
        pc.transceivers
            .filter { it.mediaType == livekit.org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO }
            .forEach { it.direction = livekit.org.webrtc.RtpTransceiver.RtpTransceiverDirection.INACTIVE }

        val created = CompletableDeferred<SessionDescription>()
        pc.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) { created.complete(d) }
            override fun onSetSuccess() {}
            override fun onCreateFailure(e: String) { created.completeExceptionally(IllegalStateException("answer: $e")) }
            override fun onSetFailure(e: String) {}
        }, MediaConstraints())
        val answer = created.await()

        val localSet = CompletableDeferred<Unit>()
        pc.setLocalDescription(SetObserver(localSet), answer)
        localSet.await()

        return localDescriptionWithCandidates()
    }

    /**
     * We are the offerer. A simple-peer browser only reports "connected" once a data channel opens, and the initiator is the
     * side that creates it, so create `simplepeer` here; audio is receive-only until M3 adds the microphone.
     */
    override suspend fun createOffer(): String? {
        val channel = pc.createDataChannel("simplepeer", DataChannel.Init())
        synchronized(keepAlive) { if (channel != null) keepAlive += channel }
        pc.addTransceiver(
            livekit.org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
            livekit.org.webrtc.RtpTransceiver.RtpTransceiverInit(livekit.org.webrtc.RtpTransceiver.RtpTransceiverDirection.RECV_ONLY),
        )
        val created = CompletableDeferred<SessionDescription>()
        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) { created.complete(d) }
            override fun onSetSuccess() {}
            override fun onCreateFailure(e: String) { created.completeExceptionally(IllegalStateException("offer: $e")) }
            override fun onSetFailure(e: String) {}
        }, MediaConstraints())
        val localSet = CompletableDeferred<Unit>()
        pc.setLocalDescription(SetObserver(localSet), created.await())
        localSet.await()
        return localDescriptionWithCandidates()
    }

    override fun acceptAnswer(answerSdp: String) {
        pc.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) {}
            override fun onSetSuccess() {}
            override fun onCreateFailure(e: String) {}
            override fun onSetFailure(e: String) { println("WaVoice[$connectionId] setRemote(answer) failed: $e") }
        }, SessionDescription(SessionDescription.Type.ANSWER, answerSdp))
    }

    /** True once ICE reports the connection is up (used by the on-device loopback test). */
    internal suspend fun awaitConnected(timeoutMs: Long): Boolean = withTimeoutOrNull(timeoutMs) { connected.await() } != null

    // Non-trickle: the SDP must carry its candidates. Wait for the first, then let the others settle.
    private suspend fun localDescriptionWithCandidates(): String? {
        gate.await(GATHER_TIMEOUT_MS, SETTLE_MS)
        val sdp = pc.localDescription?.description ?: return null
        return sdp.takeIf { "a=candidate" in it } // zero candidates is a dead connection: the caller tears down
    }

    override fun addRemoteCandidate(candidate: PeerSignal.Candidate) {
        pc.addIceCandidate(IceCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.candidate))
    }

    override fun close() {
        try { pc.close() } finally { pc.dispose() }
    }

    companion object {
        const val GATHER_TIMEOUT_MS = 4_000L
        const val SETTLE_MS = 1_000L
    }
}
