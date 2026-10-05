package app.workadventurer.app.ui

import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.SessionState
import app.workadventurer.protocol.Player

fun statusText(c: Connection): String = when (c) {
    Connection.Disconnected -> "Not in a room"
    Connection.Connecting -> "Connecting…"
    Connection.Connected -> "Connected"
    is Connection.Reconnecting -> "Reconnecting (attempt ${c.attempt}) in ${c.inMs / 1000}s"
    is Connection.Failed -> "Couldn't join: ${c.message}"
}

/** Text for the ongoing foreground-service notification. */
fun notificationText(s: SessionState): String = when (s.connection) {
    Connection.Connected -> "Connected · ${s.players.size} ${if (s.players.size == 1) "player" else "players"}"
    else -> statusText(s.connection)
}

fun playerLabel(p: Player): String = p.name.ifBlank { "Unnamed player" }
