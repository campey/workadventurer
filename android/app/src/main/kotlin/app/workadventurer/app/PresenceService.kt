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
import app.workadventurer.app.session.shouldLeaveWhenServiceStops
import app.workadventurer.app.ui.notificationText
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

    // The observer posts from a background thread. Cancelling its job doesn't wait for a notify() already
    // in flight, which on a real phone left a stale ongoing notification after Leave. All posting goes
    // through this guard so nothing can be posted once we've deactivated.
    private val postLock = Any()
    private var active = false

    private val session get() = (application as WaApp).session

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_JOIN -> {
                ensureChannel()
                synchronized(postLock) { active = true }
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
                        if (s.connection is Connection.Failed) {
                            // A join that failed for good isn't "presence": stop the foreground service (and its
                            // microphone-type notification) now. The reason stays visible in the app's status line.
                            deactivate()
                            ServiceCompat.stopForeground(this@PresenceService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                            stopSelf()
                        } else {
                            post(notificationText(s), s.muted)
                        }
                    }
                }
            }
            ACTION_TOGGLE_MUTE -> session.dispatch(Command.SetMuted(!session.state.value.muted))
            ACTION_LEAVE -> {
                deactivate()
                session.dispatch(Command.Leave)
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        deactivate()
        scope.cancel()
        // Not after a failed join: the service stops itself then, and a reset would wipe "Couldn't join: …".
        if (shouldLeaveWhenServiceStops(session.state.value)) session.dispatch(Command.Leave)
        super.onDestroy()
    }

    private fun post(text: String, muted: Boolean) = synchronized(postLock) {
        if (active) getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notification(text, muted))
    }

    /** After this returns no notification can be posted, and ours is gone. */
    private fun deactivate() = synchronized(postLock) {
        active = false
        getSystemService(NotificationManager::class.java).cancel(NOTIF_ID)
    }

    private fun notification(text: String, muted: Boolean = true): Notification {
        val leave = PendingIntent.getService(
            this, 0,
            Intent(this, PresenceService::class.java).setAction(ACTION_LEAVE),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val toggleMute = PendingIntent.getService(
            this, 1,
            Intent(this, PresenceService::class.java).setAction(ACTION_TOGGLE_MUTE),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("WorkAdventure")
            .setContentText(text)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_btn_speak_now, if (muted) "Unmute" else "Mute", toggleMute)
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
        const val ACTION_TOGGLE_MUTE = "app.workadventurer.action.TOGGLE_MUTE"
        const val EXTRA_NAME = "name"
        const val EXTRA_ROOM = "room"
        private const val CHANNEL_ID = "presence"
        private const val NOTIF_ID = 1
    }
}
