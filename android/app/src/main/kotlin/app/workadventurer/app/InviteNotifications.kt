package app.workadventurer.app

import app.workadventurer.app.ui.inviteText
import app.workadventurer.protocol.Invite

/** The foreground service's own notification id; invite notifications must never reuse it. */
const val PRESENCE_NOTIFICATION_ID = 1

/** What to show for one pending invite. No Android types, so it unit-tests on the JVM. */
data class InviteNotification(val id: Int, val title: String, val text: String)

/**
 * A stable id per sender, so re-posting the same invite updates one notification, and so a button press can be mapped
 * back to the invite without the sender's uuid (the account email for logged-in players) ever going into an intent.
 */
fun inviteNotificationId(senderUuid: String): Int =
    PRESENCE_NOTIFICATION_ID + 1 + ((senderUuid.hashCode() and 0x7fffffff) % 1_000_000)

fun inviteNotifications(invites: List<Invite>): List<InviteNotification> =
    invites.map { InviteNotification(inviteNotificationId(it.senderUuid), it.senderName.ifBlank { "Someone" }, inviteText(it)) }

/** Posted invite notifications that are no longer pending (answered in the app, or the connection dropped). */
fun staleInviteNotificationIds(posted: Set<Int>, current: List<InviteNotification>): Set<Int> =
    posted - current.map { it.id }.toSet()

fun inviteForNotificationId(invites: List<Invite>, id: Int): Invite? =
    invites.firstOrNull { inviteNotificationId(it.senderUuid) == id }
