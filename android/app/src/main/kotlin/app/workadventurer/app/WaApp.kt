package app.workadventurer.app

import android.app.Application
import android.net.TrafficStats
import android.os.Build
import android.util.Log
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.WaSession
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.WaStaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.io.File
import java.net.URI
import java.util.concurrent.TimeUnit

/** Process-wide owner of the one [WaSession]; the service, the UI and (later) media buttons all share it. */
class WaApp : Application() {
    // pingInterval is OkHttp's TCP-level websocket ping. G1 measures whether it's needed.
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    /** Your own woka layers as last seen per server, so the Join screen can preview you before connecting. */
    val lastTextures by lazy { LastTextures(PrefsStore(this)) }

    /** The audio devices and which one a call uses (#164); tracks devices from the start so the bar can show them. */
    val audioRouter: app.workadventurer.app.audio.AudioRouter by lazy { app.workadventurer.app.audio.AudioRouter(this, callLog).also { it.start() } }

    /** How often you have been in each area, per room (#159). */
    val areaVisits by lazy { AreaVisits(PrefsStore(this)) }

    /** What the Network sheet shows: the open connections, and how much the app has sent and received (#171). */
    val netHub: app.workadventurer.app.net.NetHub by lazy {
        val uid = android.os.Process.myUid()
        app.workadventurer.app.net.NetHub(
            usage = app.workadventurer.app.net.UsageTotals(PrefsStore(this)),
            traffic = { TrafficStats.getUidTxBytes(uid) to TrafficStats.getUidRxBytes(uid) },
        )
    }

    override fun onCreate() {
        super.onCreate()
        // The totals count the app's traffic from here on: read the device's counters now and then, faster while the sheet is open.
        appScope.launch {
            while (true) {
                netHub.tick()
                delay(if (netHub.wanted) 1_000L else 10_000L)
            }
        }
    }

    /** Builds and remembers the woka pictures shown across the app. */
    val wokaLoader by lazy { app.workadventurer.app.ui.WokaLoader(http) }

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Where the per-call log files live (see [CallLog]); the share action reads from here. */
    val logDir: File by lazy { File(filesDir, "logs") }

    /**
     * Every log line goes to logcat (tags WaConn, WaSession, WaVoice) and, during a call, to that call's file in [logDir]:
     * logcat only keeps about an hour, and the files are what is left the next day.
     */
    val callLog: CallLog by lazy {
        CallLog(
            CallLogFiles(logDir),
            logcat = { tag, msg -> Log.i(tag, msg) },
            logcatError = { tag, msg -> Log.e(tag, msg) },
            header = ::logHeader,
        )
    }

    private val deviceEvents by lazy { DeviceEvents(this, callLog) }

    private fun logHeader(roomUrl: String): List<String> {
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull()
        val host = runCatching { URI(roomUrl.trim()).host }.getOrNull().orEmpty()
        return listOf(
            "# WorkAdventurer Android $version",
            "# phone ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (sdk ${Build.VERSION.SDK_INT})",
            "# room $roomUrl",
            "# server ${if (host == WaStaging.HOST) "staging" else "prod"}",
            // The mic choice is remembered across joins now, so a surprise live mic must be traceable from the log alone.
            "# mic ${if (session.state.value.muted) "muted" else "on"} at join",
        )
    }

    val session: WaSession by lazy {
        val s = WaSession(
            scope = appScope,
            factory = { cfg ->
                PusherConnection(http, cfg, cacheDir = File(cacheDir, "nav")).also { c ->
                    // Every connection event goes to the log (tag WaConn), so a long soak can answer "did a silent
                    // reconnect happen, and why?" via: adb logcat -s WaConn:I WaSession:I, or the call's log file.
                    val logJob = appScope.launch { c.log.collect { callLog.i("WaConn", it) } }
                    c.closed.invokeOnCompletion { logJob.cancel() }
                }
            },
            voiceHost = MeshVoiceHost(this, callLog, audioRouter, netHub),
            log = { callLog.i("WaSession", it) },
        )
        // Our own picture arrives in the room-joined message; keep it for the Join screen's preview.
        appScope.launch {
            s.state.map { it.roomName to it.myTextures }.distinctUntilChanged().collect { (room, layers) ->
                if (layers.isNotEmpty()) lastTextures.remember(room, layers)
            }
        }
        // A visit to an area is being in it for a few seconds: crossing one on the way elsewhere doesn't count (#159).
        appScope.launch {
            var counted = emptySet<String>()
            s.state.map { it.roomName to it.inAreas.map { a -> a.id ?: a.name }.toSet() }.distinctUntilChanged().collectLatest { (room, now) ->
                delay(VISIT_DWELL_MS)
                areasEntered(counted, now).forEach { areaVisits.record(room, it) }
                counted = now
            }
        }
        // How much of the room the server has told us about (it only streams what is near us): counts only, no names.
        appScope.launch {
            s.state.map { it.players.size to it.groups.size }.distinctUntilChanged().collect { (p, g) ->
                callLog.i("WaSession", "known: $p player(s), $g bubble(s)")
            }
        }
        // A call's file opens when a Join sets Connecting and closes on Leave or a failed join; see CallLog.onConnection.
        appScope.launch {
            s.state.map { it.connection to it.roomName }.distinctUntilChanged().collect { (connection, room) ->
                callLog.onConnection(connection, room)
                // Device events only while a call's file is open (the file exists by now: onConnection opened it first).
                when (connection) {
                    Connection.Connecting -> { deviceEvents.start(); netHub.startSession() }
                    Connection.Disconnected, is Connection.Failed -> deviceEvents.stop()
                    else -> {}
                }
            }
        }
        s
    }
}

private const val VISIT_DWELL_MS = 5_000L
