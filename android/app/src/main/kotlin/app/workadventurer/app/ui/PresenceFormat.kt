package app.workadventurer.app.ui

import app.workadventurer.app.session.Activity
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.InviteStatus
import app.workadventurer.app.session.SessionState
import app.workadventurer.protocol.Invite
import app.workadventurer.protocol.Player

fun statusText(c: Connection): String = when (c) {
    Connection.Disconnected -> "Not in a room"
    Connection.Connecting -> "Connecting…"
    Connection.Connected -> "Connected"
    is Connection.Reconnecting -> "Reconnecting (attempt ${c.attempt}) in ${c.inMs / 1000}s"
    is Connection.Failed -> "Couldn't join: ${c.message}"
}

/** Text for the ongoing foreground-service notification. */
fun micText(muted: Boolean): String = if (muted) "Microphone muted" else "Microphone on"

fun notificationText(s: SessionState): String = when (s.connection) {
    Connection.Connected ->
        "Connected · ${s.players.size} ${if (s.players.size == 1) "player" else "players"} · mic ${if (s.muted) "muted" else "on"}"
    else -> statusText(s.connection)
}

/** The movement status line, or null when the avatar isn't walking anywhere. */
fun activityText(a: Activity): String? = when (a) {
    Activity.Idle -> null
    is Activity.WalkingTo -> "Walking to ${a.label}"
    is Activity.WalkingOut -> "Walking out of ${a.label}"
}

/** What happened to the invite we sent, or null if we haven't sent one. */
fun inviteStatusText(s: InviteStatus?): String? = when (s) {
    null -> null
    is InviteStatus.Sent -> "Invited ${s.label}…"
    is InviteStatus.Accepted -> "${s.name} accepted your invitation"
    is InviteStatus.Declined -> "${s.name} declined your invitation"
    InviteStatus.TooMany -> "Too many invitations; try again in a moment"
}

/** One incoming invitation, as a sentence. */
fun inviteText(i: Invite): String = "${i.senderName.ifBlank { "Someone" }} invited you over"

fun playerLabel(p: Player): String = p.name.ifBlank { "Unnamed player" }
