package app.workadventurer.app

import android.content.Context
import android.media.AudioManager
import android.util.Log
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.voice.MeshSession
import app.workadventurer.voice.VoiceEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Starts the voice mesh for one live connection and tears it down with it. Platform glue: verified on the phone. */
class MeshVoiceHost(private val context: Context) : (PusherConnection) -> AutoCloseable {
    override fun invoke(conn: PusherConnection): AutoCloseable {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val audio = context.getSystemService(AudioManager::class.java)
        val previousMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION // voice-call routing and volume
        val engine = VoiceEngine(context) // at join, so the network list is known by the first bubble
        val ice = scope.async { conn.iceServers() }
        val mesh = MeshSession(
            links = { id -> engine.newLink(id, ice.await()) },
            sink = { space, peer, id, signal -> conn.sendSignal(space, peer, id, signal) },
            log = { Log.i("WaVoice", it) },
        )
        scope.launch { mesh.run(conn.voiceEvents) }
        return AutoCloseable {
            scope.cancel()
            mesh.closeAll()
            engine.close()
            audio.mode = previousMode
        }
    }
}
