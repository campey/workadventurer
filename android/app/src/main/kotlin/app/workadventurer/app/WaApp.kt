package app.workadventurer.app

import android.app.Application
import android.util.Log
import app.workadventurer.app.session.WaSession
import app.workadventurer.protocol.PusherConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** Process-wide owner of the one [WaSession]; the service, the UI and (later) media buttons all share it. */
class WaApp : Application() {
    // pingInterval is OkHttp's TCP-level websocket ping. G1 measures whether it's needed.
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val session: WaSession by lazy {
        val s = WaSession(
            scope = appScope,
            factory = { cfg ->
                PusherConnection(http, cfg, cacheDir = File(cacheDir, "nav")).also { c ->
                    // Every connection event goes to logcat (tag WaConn), so a long soak can answer "did a silent
                    // reconnect happen, and why?" via: adb logcat -s WaConn:I WaSession:I
                    val logJob = appScope.launch { c.log.collect { Log.i("WaConn", it) } }
                    c.closed.invokeOnCompletion { logJob.cancel() }
                }
            },
        )
        appScope.launch {
            s.state.map { it.connection }.distinctUntilChanged().collect { Log.i("WaSession", it.toString()) }
        }
        s
    }
}
