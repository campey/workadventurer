package app.workadventurer.app

import android.app.Application
import app.workadventurer.app.session.WaSession
import app.workadventurer.protocol.PusherConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Process-wide owner of the one [WaSession]; the service, the UI and (later) media buttons all share it. */
class WaApp : Application() {
    // pingInterval is OkHttp's TCP-level websocket ping. G1 measures whether it's needed.
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()

    val session: WaSession by lazy {
        WaSession(
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
            factory = { cfg -> PusherConnection(http, cfg) },
        )
    }
}
