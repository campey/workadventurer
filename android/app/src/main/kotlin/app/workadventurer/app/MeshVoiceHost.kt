package app.workadventurer.app

import android.content.Context
import android.media.AudioManager
import android.util.Log
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.VoiceEvent
import app.workadventurer.voice.MeshSession
import app.workadventurer.voice.VoiceEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Starts the voice mesh for one live connection and tears it down with it. Platform glue: verified on the phone.
 *
 * Lifecycle rules, from the whole-branch review:
 * - subscribe to the connection's voice events *first*, before the native library loads, and buffer them, so an early
 *   `webRtcStart` isn't lost (a lost "you offer" start brings back the 20 s browser-timeout fallback);
 * - everything native (mesh links, then the engine) is torn down on the job's own coroutine, after any in-flight negotiation
 *   has returned, never from another thread while native code may still be using it;
 * - nothing thrown in here may leave the job uncaught (that would crash the app) or leave the audio mode changed.
 */
class MeshVoiceHost(private val context: Context) : (PusherConnection) -> AutoCloseable {
    override fun invoke(conn: PusherConnection): AutoCloseable {
        val scope = CoroutineScope(
            SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, t -> Log.e("WaVoice", "voice stopped: ${t.message}") },
        )
        val inbox = Channel<VoiceEvent>(Channel.UNLIMITED)
        scope.launch(start = CoroutineStart.UNDISPATCHED) { conn.voiceEvents.collect { inbox.trySend(it) } }

        val audio = context.getSystemService(AudioManager::class.java)
        val previousMode = audio.mode
        // ATOMIC: the body (and so its cleanup) always runs, even if the host is closed before the job gets to start.
        scope.launch(start = CoroutineStart.ATOMIC) {
            var engine: VoiceEngine? = null
            var mesh: MeshSession? = null
            try {
                audio.mode = AudioManager.MODE_IN_COMMUNICATION // voice-call routing and volume
                val e = VoiceEngine(context) // at join, so the network list is known by the first bubble
                engine = e
                val ice = async { conn.iceServers() }
                val m = MeshSession(
                    links = { id -> e.newLink(id, ice.await()) },
                    sink = { space, peer, id, signal -> conn.sendSignal(space, peer, id, signal) },
                    log = { Log.i("WaVoice", it) },
                )
                mesh = m
                m.run(inbox.receiveAsFlow())
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                Log.e("WaVoice", "voice failed to start or crashed: ${t.message}")
            } finally {
                withContext(NonCancellable) {
                    try { mesh?.closeAll() } catch (t: Throwable) { Log.e("WaVoice", "closing links failed: ${t.message}") }
                    try { engine?.close() } catch (t: Throwable) { Log.e("WaVoice", "closing the engine failed: ${t.message}") }
                    audio.mode = previousMode
                }
            }
        }
        return AutoCloseable { scope.cancel() }
    }
}
