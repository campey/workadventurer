package app.workadventurer.app.ui

import app.workadventurer.app.session.Connection
import app.workadventurer.proto.PositionMessage
import app.workadventurer.protocol.Player
import kotlin.test.Test
import kotlin.test.assertEquals

class PresenceFormatTest {
    @Test fun statusTextCoversEveryState() {
        assertEquals("Not in a room", statusText(Connection.Disconnected))
        assertEquals("Connecting…", statusText(Connection.Connecting))
        assertEquals("Connected", statusText(Connection.Connected))
        assertEquals("Reconnecting (attempt 2) in 4s", statusText(Connection.Reconnecting(2, 4_000)))
        assertEquals("Couldn't join: token expired", statusText(Connection.Failed("token expired")))
    }

    @Test fun playerLabelHandlesEmptyName() {
        val p = Player(1, "", "u", 0, 0, PositionMessage.Direction.DOWN)
        assertEquals("Unnamed player", playerLabel(p))
        assertEquals("Ada", playerLabel(p.copy(name = "Ada")))
    }
}
