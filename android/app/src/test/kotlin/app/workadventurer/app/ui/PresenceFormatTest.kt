package app.workadventurer.app.ui

import app.workadventurer.app.session.Activity
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.SessionState
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

    @Test fun notificationTextSaysWhatIsHappeningAndPluralisesCorrectly() {
        fun state(c: Connection, players: Int = 0) = SessionState(
            connection = c,
            players = List(players) { Player(it, "p$it", "u$it", 0, 0, PositionMessage.Direction.DOWN) },
        )
        assertEquals("Connected · 0 players", notificationText(state(Connection.Connected, 0)))
        assertEquals("Connected · 1 player", notificationText(state(Connection.Connected, 1)))
        assertEquals("Connected · 3 players", notificationText(state(Connection.Connected, 3)))
        // Disconnected must not read "Connecting…" (seen on a real phone after Leave).
        assertEquals("Not in a room", notificationText(state(Connection.Disconnected)))
        assertEquals("Connecting…", notificationText(state(Connection.Connecting)))
        assertEquals("Reconnecting (attempt 1) in 1s", notificationText(state(Connection.Reconnecting(1, 1_000))))
        assertEquals("Couldn't join: nope", notificationText(state(Connection.Failed("nope"))))
    }

    @Test fun activityTextDescribesWhatTheAvatarIsDoing() {
        assertEquals(null, activityText(Activity.Idle))
        assertEquals("Following Ada", activityText(Activity.Following("Ada")))
        assertEquals("Walking to Fire pit", activityText(Activity.WalkingTo("Fire pit")))
    }

    @Test fun playerLabelHandlesEmptyName() {
        val p = Player(1, "", "u", 0, 0, PositionMessage.Direction.DOWN)
        assertEquals("Unnamed player", playerLabel(p))
        assertEquals("Ada", playerLabel(p.copy(name = "Ada")))
    }
}
