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

/** The answering side of one simple-peer connection. Remote audio plays through the audio device module on its own. */
internal class WebRtcPeerLink(
    factory: PeerConnectionFactory,
    private val connectionId: String,
    iceServers: List<IceServerInfo>,
) : PeerLink {
    // libwebrtc can report gathering COMPLETE *before* the first candidate is delivered (seen on the S25: COMPLETE, then one
    // host candidate, no srflx), so "complete" alone says nothing. We wait for a first candidate, then give the rest (the
    // STUN-reflexive one) a bounded moment to settle.
    private val candidates = AtomicInteger(0)
    @Volatile private var complete = false
    private val firstCandidate = CompletableDeferred<Unit>()
    private val settled = CompletableDeferred<Unit>()
    private val keepAlive = mutableListOf<Any>() // data channel references: libwebrtc drops channels nobody holds

    private fun checkSettled() { if (candidates.get() > 0 && complete) settled.complete(Unit) }

    private val pc: PeerConnection = factory.createPeerConnection(
        PeerConnection.RTCConfiguration(iceServers.map {
            PeerConnection.IceServer.builder(it.urls).apply { it.username?.let(::setUsername); it.credential?.let(::setPassword) }.createIceServer()
        }).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN },
        object : PeerConnection.Observer {
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {
                if (s == PeerConnection.IceGatheringState.COMPLETE) { complete = true; checkSettled() }
            }
            override fun onIceCandidate(c: IceCandidate) {
                candidates.incrementAndGet(); firstCandidate.complete(Unit); checkSettled()
            }
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

        // Non-trickle: the answer must carry its candidates. Wait for the first, then let the others settle.
        withTimeoutOrNull(GATHER_TIMEOUT_MS) { firstCandidate.await() }
        withTimeoutOrNull(SETTLE_MS) { settled.await() }
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
