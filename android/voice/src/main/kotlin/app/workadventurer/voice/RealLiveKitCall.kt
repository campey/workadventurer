package app.workadventurer.voice

import android.content.Context
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * The real [LiveKitCall] (#134): a LiveKit [Room] for one meeting. Platform glue, checked on the phone.
 *
 * - The room plays everyone it hears by itself. It does not touch the audio mode or routing (the app's AudioRouter does that), hence
 *   [NoAudioHandler].
 * - Our microphone is published only while unmuted, so a muted phone never opens the microphone for the room.
 * - Nothing about the server (address, token) is ever logged.
 */
class RealLiveKitCall(
    context: Context,
    private val log: (String) -> Unit = {},
) : LiveKitCall {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val micChanges = Channel<Boolean>(Channel.CONFLATED) // true = muted; the latest choice wins, applied one at a time
    @Volatile private var room: Room? = null
    @Volatile private var muted = true

    override suspend fun connect(serverUrl: String, token: String) {
        val r = LiveKit.create(
            appContext, overrides = LiveKitOverrides(audioOptions = AudioOptions(audioHandler = NoAudioHandler())),
        )
        room = r
        scope.launch {
            r.events.events.collect { e ->
                when (e) {
                    is RoomEvent.Disconnected -> log("LiveKit room disconnected (${e.reason})")
                    is RoomEvent.Reconnecting -> log("LiveKit room reconnecting")
                    is RoomEvent.Reconnected -> log("LiveKit room reconnected")
                    is RoomEvent.TrackSubscribed -> log("LiveKit: hearing a track (${e.track.kind})")
                    is RoomEvent.ActiveSpeakersChanged -> log("LiveKit: ${e.speakers.size} speaking")
                    else -> Unit
                }
            }
        }
        try {
            r.connect(serverUrl, token)
        } catch (c: CancellationException) {
            throw c
        }
        // Mic changes made while connecting are applied now, then as they come.
        scope.launch {
            applyMic(muted)
            for (m in micChanges) applyMic(m)
        }
    }

    private suspend fun applyMic(muted: Boolean) {
        try {
            room?.localParticipant?.setMicrophoneEnabled(!muted)
            log("LiveKit microphone ${if (muted) "off" else "on"}")
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            log("LiveKit microphone change failed (${t.javaClass.simpleName})")
        }
    }

    override fun setMuted(muted: Boolean) {
        this.muted = muted
        micChanges.trySend(muted)
    }

    override fun close() {
        val r = room; room = null
        scope.cancel()
        try { r?.disconnect() } catch (t: Throwable) { log("LiveKit disconnect failed (${t.javaClass.simpleName})") }
        try { r?.release() } catch (t: Throwable) { log("LiveKit release failed (${t.javaClass.simpleName})") }
    }
}
