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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.workadventurer.app.ui.PresenceScreen

class MainActivity : ComponentActivity() {
    private val notice = mutableStateOf<String?>(null)
    private var pendingJoin: Pair<String, String>? = null

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
                    onJoin = ::requestJoin,
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

    private fun requestJoin(name: String, room: String) {
        notice.value = null
        pendingJoin = name to room
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) startPresence() else permissions.launch(needed.toTypedArray())
    }

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
