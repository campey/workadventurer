package app.workadventurer.app.ui

import app.workadventurer.app.session.SessionState
import app.workadventurer.proto.PositionMessage
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.MeetingRoom
import app.workadventurer.protocol.Player
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class JitsiTest {
    private fun area(id: String, name: String, props: Set<String>, meeting: Boolean = false) =
        Area(id, name, 0, 0, 100, 100, props, false, false, if (meeting) MeetingRoom("p", name) else null)

    private val jitsi = area("j", "Right Board Room", setOf("jitsiRoomProperty"))
    private val livekit = area("l", "Red Table", setOf("livekitRoomProperty"), meeting = true)
    private val plain = area("s", "Spawn Point", emptySet())

    @Test
    fun theMessageNamesTheIssue() {
        assertEquals("Jitsi meetings not (yet) supported (#119)", JITSI_NOT_SUPPORTED_MESSAGE)
    }

    @Test
    fun onlyAJitsiAreaIsJitsi() {
        assertEquals(true, jitsi.isJitsi())
        assertEquals(false, livekit.isJitsi())
        assertEquals(false, plain.isJitsi())
        // an area that is both: the LiveKit room is the one we can use
        assertEquals(false, area("b", "Both", setOf("jitsiRoomProperty", "livekitRoomProperty"), meeting = true).isJitsi())
    }

    // The warning is for walking INTO one: standing in it already, or being in other areas, says nothing.
    @Test
    fun enteringAJitsiAreaIsNoticedOnce() {
        assertEquals(jitsi, jitsiEntered(before = emptyList(), now = listOf(jitsi)))
        assertEquals(jitsi, jitsiEntered(before = listOf(plain), now = listOf(plain, jitsi)))
        assertNull(jitsiEntered(before = listOf(jitsi), now = listOf(jitsi))) // still in it
        assertNull(jitsiEntered(before = listOf(jitsi), now = emptyList())) // leaving it
        assertNull(jitsiEntered(before = emptyList(), now = listOf(livekit, plain)))
    }

    private fun player(id: Int, name: String, x: Int, y: Int) = Player(id, name, "u$id", x, y, PositionMessage.Direction.DOWN)

    @Test
    fun someoneInAJitsiAreaIsInAJitsiMeetingAndYouCannotJoinThem() {
        val s = SessionState(players = listOf(player(2, "Diccon", 50, 50)), areas = listOf(jitsi), myUserId = 1, myName = "Me")
        val w = whereIs(2, s) as Whereabouts.InArea
        assertEquals(true, w.jitsi)
        assertEquals("In Right Board Room (Jitsi meeting)", whereText(w))
        assertEquals(JITSI_NOT_SUPPORTED_MESSAGE, walkExplainer(w))
    }

    // Standing in the same Jitsi room is not "together" for us: we cannot be in that call.
    @Test
    fun beingInTheSameJitsiAreaIsNotBeingTogether() {
        val s = SessionState(players = listOf(player(2, "Diccon", 50, 50)), areas = listOf(jitsi), inAreas = listOf(jitsi), myUserId = 1, myName = "Me")
        val w = whereIs(2, s)
        assertEquals(false, w.isTogether())
        assertEquals(JITSI_NOT_SUPPORTED_MESSAGE, walkExplainer(w))
    }
}
