package app.workadventurer.app.ui

import app.workadventurer.app.session.Connection
import app.workadventurer.protocol.Player

fun statusText(c: Connection): String = when (c) {
    Connection.Disconnected -> "Not in a room"
    Connection.Connecting -> "Connecting…"
    Connection.Connected -> "Connected"
    is Connection.Reconnecting -> "Reconnecting (attempt ${c.attempt}) in ${c.inMs / 1000}s"
    is Connection.Failed -> "Couldn't join: ${c.message}"
}

fun playerLabel(p: Player): String = p.name.ifBlank { "Unnamed player" }
