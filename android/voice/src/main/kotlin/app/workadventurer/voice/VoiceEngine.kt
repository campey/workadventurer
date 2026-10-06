package app.workadventurer.voice

import android.content.Context
import app.workadventurer.protocol.IceServerInfo
import kotlinx.coroutines.delay
import livekit.org.webrtc.AudioSource
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.SoftwareVideoDecoderFactory
import livekit.org.webrtc.SoftwareVideoEncoderFactory
import livekit.org.webrtc.audio.JavaAudioDeviceModule

/**
 * Owns the one libwebrtc [PeerConnectionFactory] and the one local microphone track that every link sends. Create it at
 * join, not at the first bubble: gathering that starts right after the factory exists finds no network (0 candidates), so
 * links wait until the engine is [WARM_UP_MS] old. It starts muted.
 */
class VoiceEngine(context: Context) {
    private val createdAt = System.nanoTime()
    internal val factory: PeerConnectionFactory
    private val adm: JavaAudioDeviceModule
    private val micSource: AudioSource
    internal val micTrack: AudioTrack

    init {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
        adm = JavaAudioDeviceModule.builder(context.applicationContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        // A browser offer always carries an m=video section. With no video codecs registered, libwebrtc aborts the process
        // while answering it ("front() called on an empty vector"), the same trap as werift's "no codec overlap". We never
        // send or show video, so the software codecs only exist to let the section be negotiated.
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(SoftwareVideoEncoderFactory())
            .setVideoDecoderFactory(SoftwareVideoDecoderFactory())
            .createPeerConnectionFactory()
        micSource = factory.createAudioSource(MediaConstraints())
        micTrack = factory.createAudioTrack("wa-mic", micSource)
        setMuted(true)
    }

    /**
     * Muting makes the track send silence and mutes the capture itself. The track keeps flowing RTP either way, which is
     * what stops a browser peer flagging our mic red between utterances (issue #10): no keepalive stream is needed.
     */
    fun setMuted(muted: Boolean) {
        micTrack.setEnabled(!muted)
        adm.setMicrophoneMute(muted)
    }

    suspend fun newLink(connectionId: String, iceServers: List<IceServerInfo>): PeerLink {
        val waited = (System.nanoTime() - createdAt) / 1_000_000
        if (waited < WARM_UP_MS) delay(WARM_UP_MS - waited)
        return WebRtcPeerLink(factory, connectionId, iceServers, micTrack)
    }

    fun close() {
        micTrack.dispose(); micSource.dispose()
        factory.dispose()
        adm.release()
    }

    companion object { const val WARM_UP_MS = 1_500L }
}
