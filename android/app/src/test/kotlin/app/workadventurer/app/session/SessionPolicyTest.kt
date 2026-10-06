package app.workadventurer.app.session

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SessionPolicyTest {
    private fun state(c: Connection) = SessionState(connection = c)

    @Test
    fun aFailedJoinKeepsItsReasonWhenTheServiceStops() {
        // The service stops itself on a failed join; resetting the session then wiped "Couldn't join: …" within
        // 6 ms (seen on a real phone). The reason must stay visible until the next Join or an explicit Leave.
        assertFalse(shouldLeaveWhenServiceStops(state(Connection.Failed("nope"))))
    }

    @Test
    fun everyOtherStateIsLeftWhenTheServiceStops() {
        for (c in listOf(Connection.Disconnected, Connection.Connecting, Connection.Connected, Connection.Reconnecting(1, 1_000))) {
            assertTrue(shouldLeaveWhenServiceStops(state(c)), "$c")
        }
        assertEquals(true, shouldLeaveWhenServiceStops(SessionState()))
    }
}
