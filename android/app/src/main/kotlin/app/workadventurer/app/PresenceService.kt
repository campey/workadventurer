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
import androidx.core.app.Person
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
                            post(notificationText(s))
                            syncInviteNotifications(inviteNotifications(s.pendingInvites))
                        }
                    }
                }
            }
            ACTION_ACCEPT_INVITE, ACTION_DECLINE_INVITE -> {
                // The notification carries only its own id; the sender's uuid (an email) stays inside the session.
                val id = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)
                inviteForNotificationId(session.state.value.pendingInvites, id)?.let {
                    session.dispatch(
                        if (intent.action == ACTION_ACCEPT_INVITE) Command.AcceptInvite(it.senderUuid)
                        else Command.DeclineInvite(it.senderUuid),
                    )
                }
                // the observer cancels it once the invite leaves the pending list; this is just immediate feedback
                getSystemService(NotificationManager::class.java).cancel(id)
            }
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

    private fun post(text: String) = synchronized(postLock) {
        if (active) getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notification(text))
    }

    private val postedInvites = mutableSetOf<Int>() // guarded by postLock

    /** Post what is pending (updating in place) and cancel what no longer is. */
    private fun syncInviteNotifications(current: List<InviteNotification>) = synchronized(postLock) {
        if (!active) return@synchronized
        val nm = getSystemService(NotificationManager::class.java)
        for (id in staleInviteNotificationIds(postedInvites, current)) nm.cancel(id)
        postedInvites.clear()
        for (n in current) {
            nm.notify(n.id, inviteNotification(n))
            postedInvites += n.id
        }
    }

    /** After this returns no notification can be posted, and ours are gone. */
    private fun deactivate() = synchronized(postLock) {
        active = false
        val nm = getSystemService(NotificationManager::class.java)
        nm.cancel(NOTIF_ID)
        postedInvites.forEach { nm.cancel(it) }
        postedInvites.clear()
    }

    /**
     * Styled as an incoming call: Accept and Decline, high importance. Android requires a call-style notification to be
     * a foreground-service notification or carry a full-screen intent; this one is separate from the service's, so it
     * carries one (opening the app). Where the full-screen permission isn't granted it still shows as a heads-up.
     */
    private fun inviteNotification(n: InviteNotification): Notification {
        fun action(name: String, requestCode: Int) = PendingIntent.getService(
            this, requestCode,
            Intent(this, PresenceService::class.java).setAction(name).putExtra(EXTRA_NOTIFICATION_ID, n.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(
            this, n.id, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val caller = Person.Builder().setName(n.title).setImportant(true).build()
        return NotificationCompat.Builder(this, INVITE_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentText(n.text)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    caller, action(ACTION_DECLINE_INVITE, n.id * 2), action(ACTION_ACCEPT_INVITE, n.id * 2 + 1),
                ),
            )
            .setAutoCancel(true)
            .build()
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
        // Earlier builds used other channel ids (one with a ringtone); a channel's sound can't be changed once created.
        nm.deleteNotificationChannel(OLD_INVITE_CHANNEL_ID)
        nm.deleteNotificationChannel(RINGING_INVITE_CHANNEL_ID)
        if (nm.getNotificationChannel(INVITE_CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(INVITE_CHANNEL_ID, "Invitations", NotificationManager.IMPORTANCE_HIGH),
            )
        }
    }

    companion object {
        const val ACTION_JOIN = "app.workadventurer.action.JOIN"
        const val ACTION_LEAVE = "app.workadventurer.action.LEAVE"
        const val ACTION_ACCEPT_INVITE = "app.workadventurer.action.ACCEPT_INVITE"
        const val ACTION_DECLINE_INVITE = "app.workadventurer.action.DECLINE_INVITE"
        const val EXTRA_NAME = "name"
        const val EXTRA_ROOM = "room"
        const val EXTRA_NOTIFICATION_ID = "notificationId"
        private const val CHANNEL_ID = "presence"
        private const val INVITE_CHANNEL_ID = "invitations-v3"
        private const val OLD_INVITE_CHANNEL_ID = "invitations"
        private const val RINGING_INVITE_CHANNEL_ID = "invitations-ring"
        private const val NOTIF_ID = PRESENCE_NOTIFICATION_ID
    }
}
