package app.workadventurer.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import app.workadventurer.app.session.Command
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.SessionState
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.Wa133
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Foreground service (type microphone) that keeps the avatar present while the app is backgrounded or
 * the screen is off. Platform glue only: all behaviour lives in WaSession, reached via [Command]s.
 * Needs RECORD_AUDIO granted *before* it starts, or startForeground throws on API 34.
 */
class PresenceService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var observer: Job? = null

    private val session get() = (application as WaApp).session

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_JOIN -> {
                ensureChannel()
                ServiceCompat.startForeground(
                    this, NOTIF_ID, notification("Connecting…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
                )
                val cfg = RoomConfig(
                    name = intent.getStringExtra(EXTRA_NAME).orEmpty(),
                    roomUrl = intent.getStringExtra(EXTRA_ROOM) ?: Wa133.DEFAULT_ROOM,
                )
                session.dispatch(Command.Join(cfg))
                observer?.cancel()
                observer = scope.launch {
                    session.state.collect { s ->
                        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notification(summary(s)))
                    }
                }
            }
            ACTION_LEAVE -> {
                session.dispatch(Command.Leave)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        session.dispatch(Command.Leave)
        scope.cancel()
        super.onDestroy()
    }

    private fun summary(s: SessionState): String = when (val c = s.connection) {
        Connection.Connected -> "Connected · ${s.players.size} players"
        Connection.Connecting, Connection.Disconnected -> "Connecting…"
        is Connection.Reconnecting -> "Reconnecting…"
        is Connection.Failed -> "Failed: ${c.message}"
    }

    private fun notification(text: String): Notification {
        val leave = PendingIntent.getService(
            this, 0,
            Intent(this, PresenceService::class.java).setAction(ACTION_LEAVE),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("WorkAdventure")
            .setContentText(text)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Leave", leave)
            .build()
    }

    private fun ensureChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Presence", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    companion object {
        const val ACTION_JOIN = "app.workadventurer.action.JOIN"
        const val ACTION_LEAVE = "app.workadventurer.action.LEAVE"
        const val EXTRA_NAME = "name"
        const val EXTRA_ROOM = "room"
        private const val CHANNEL_ID = "presence"
        private const val NOTIF_ID = 1
    }
}
