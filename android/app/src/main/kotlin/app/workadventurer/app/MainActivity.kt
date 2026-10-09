package app.workadventurer.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.workadventurer.app.session.Command
import app.workadventurer.app.ui.AppRoot
import app.workadventurer.app.ui.WorkAdventurerTheme

/** The single activity: permissions and the foreground-service handoff live here; everything on screen is in [AppRoot]. */
class MainActivity : ComponentActivity() {
    private val notice = mutableStateOf<String?>(null)
    private val micWanted = mutableStateOf(false)
    private var pendingJoin: Pair<String, String>? = null
    private val prefs by lazy { PrefsStore(this) }
    private val lastName by lazy { LastName(prefs) }
    private val lastMic by lazy { LastMic(prefs) }

    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            // A microphone-type foreground service throws on API 34 unless RECORD_AUDIO is already granted.
            if (granted[Manifest.permission.RECORD_AUDIO] == true) startPresence()
            else notice.value = "Microphone permission is needed to stay connected in the background"
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        micWanted.value = lastMic.isOn()
        val session = (application as WaApp).session
        setContent {
            WorkAdventurerTheme {
                val state by session.state.collectAsStateWithLifecycle()
                AppRoot(
                    state = state,
                    micWanted = micWanted.value,
                    notice = notice.value,
                    initialName = lastName.get(),
                    onJoin = ::requestJoin,
                    onLeave = {
                        notice.value = null
                        startService(Intent(this, PresenceService::class.java).setAction(PresenceService.ACTION_LEAVE))
                    },
                    onShareLogs = ::shareLogs,
                    onShareLink = ::shareLink,
                    wokaLoader = (application as WaApp).wokaLoader,
                    onMicChoice = ::chooseMic,
                    // Movement goes straight to the session; only Join/Leave go through the foreground service.
                    onCommand = { session.dispatch(it) },
                )
            }
        }
    }

    /** The mic button: remembered for next time either way, and applied now when in a room. */
    private fun chooseMic(muted: Boolean) {
        micWanted.value = !muted
        lastMic.remember(!muted)
        (application as WaApp).session.let { s ->
            if (s.state.value.connection !is app.workadventurer.app.session.Connection.Disconnected &&
                s.state.value.connection !is app.workadventurer.app.session.Connection.Failed &&
                s.state.value.connection !is app.workadventurer.app.session.Connection.Connecting
            ) s.dispatch(Command.SetMuted(muted))
        }
    }

    /** Hands the last few call logs to the share sheet (mail, Drive, a messenger...), so they can leave the phone without adb. */
    private fun shareLogs() {
        val files = latestLogFiles((application as WaApp).logDir, SHARED_LOGS)
        if (files.isEmpty()) { notice.value = "No call logs yet"; return }
        val uris = ArrayList(files.map { FileProvider.getUriForFile(this, "$packageName.logs", it) })
        val send = Intent(Intent.ACTION_SEND_MULTIPLE)
            .setType("text/plain")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
            .putExtra(Intent.EXTRA_SUBJECT, "WorkAdventurer call logs")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(send, "Share call logs"))
    }

    /** Hands the room's address (no token) to the share sheet, so a link to it can go to anyone. */
    private fun shareLink(url: String) {
        if (url.isEmpty()) return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
        startActivity(Intent.createChooser(send, "Share link to room"))
    }

    private fun requestJoin(name: String, room: String) {
        notice.value = null
        lastName.remember(name)
        pendingJoin = name to room
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) startPresence() else permissions.launch(needed.toTypedArray())
    }

    private companion object { const val SHARED_LOGS = 5 }

    private fun startPresence() {
        val (name, room) = pendingJoin ?: return
        ContextCompat.startForegroundService(
            this,
            Intent(this, PresenceService::class.java)
                .setAction(PresenceService.ACTION_JOIN)
                .putExtra(PresenceService.EXTRA_NAME, name)
                .putExtra(PresenceService.EXTRA_ROOM, room)
                .putExtra(PresenceService.EXTRA_MIC_ON, micWanted.value),
        )
    }
}
