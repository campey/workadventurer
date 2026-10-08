package app.workadventurer.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.workadventurer.app.ui.PresenceScreen

class MainActivity : ComponentActivity() {
    private val notice = mutableStateOf<String?>(null)
    private var pendingJoin: Pair<String, String>? = null
    private val lastName by lazy { LastName(PrefsStore(this)) }

    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            // A microphone-type foreground service throws on API 34 unless RECORD_AUDIO is already granted.
            if (granted[Manifest.permission.RECORD_AUDIO] == true) startPresence()
            else notice.value = "Microphone permission is needed to stay connected in the background"
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val session = (application as WaApp).session
        setContent {
            MaterialTheme {
                val state by session.state.collectAsStateWithLifecycle()
                PresenceScreen(
                    state = state,
                    notice = notice.value,
                    initialName = lastName.get(),
                    onJoin = ::requestJoin,
                    onShareLogs = ::shareLogs,
                    // Movement goes straight to the session; only Join/Leave go through the foreground service.
                    onCommand = { session.dispatch(it) },
                    onLeave = {
                        notice.value = null
                        startService(Intent(this, PresenceService::class.java).setAction(PresenceService.ACTION_LEAVE))
                    },
                )
            }
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
                .putExtra(PresenceService.EXTRA_ROOM, room),
        )
    }
}
