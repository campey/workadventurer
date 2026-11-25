package app.workadventurer.app.ui

import app.workadventurer.app.session.SessionState
import app.workadventurer.proto.PositionMessage
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.Group
import app.workadventurer.protocol.MeetingRoom
import app.workadventurer.protocol.Player
import kotlin.test.Test
import kotlin.test.assertEquals

// The chimes the web client plays as you and others come and go (ProximityChatRoom, v1.35.1), decided from the room's state (#134).
class SoundCuesTest {
    private fun player(id: Int, x: Int = 500, y: Int = 500) = Player(id, "P$id", "u$id", x, y, PositionMessage.Direction.DOWN)
    private val red = Area("red", "Red Table", 0, 0, 100, 100, setOf("livekitRoomProperty"), false, false, MeetingRoom("p", "Red Table"))

    private fun inBubble(vararg others: Int, size: Int = others.size) = SessionState(
        players = others.map { player(it) }, groups = listOf(Group(7, 0, 0, listOf(1) + others.toList())), myGroupId = 7, myUserId = 1, myName = "Me",
    ).also { check(size == others.size) }
    private val alone = SessionState(myUserId = 1, myName = "Me")
    private fun inRed(vararg others: Int) = SessionState(
        players = others.map { player(it, 10, 10) }, areas = listOf(red), inAreas = listOf(red), myUserId = 1, myName = "Me",
    )

    @Test fun nothingBeforeTheFirstState() = assertEquals(emptyList(), soundCues(null, inBubble(2)))
    @Test fun nothingWhenNothingChanged() = assertEquals(emptyList(), soundCues(inBubble(2), inBubble(2)))

    @Test fun joiningABubbleRingsIn() = assertEquals(listOf(Cue.BubbleIn), soundCues(alone, inBubble(2)))
    @Test fun leavingABubbleRingsOut() = assertEquals(listOf(Cue.BubbleOut), soundCues(inBubble(2), alone))
    @Test fun joiningAMeetingAreaRingsTheMeetingIn() = assertEquals(listOf(Cue.MeetingIn), soundCues(alone, inRed()))
    @Test fun leavingAMeetingAreaRingsTheMeetingOut() = assertEquals(listOf(Cue.MeetingOut), soundCues(inRed(), alone))

    @Test fun someoneJoiningYourBubbleRingsIn() = assertEquals(listOf(Cue.BubbleIn), soundCues(inBubble(2), inBubble(2, 3)))
    @Test fun someoneLeavingYourBubbleRingsOut() = assertEquals(listOf(Cue.BubbleOut), soundCues(inBubble(2, 3), inBubble(2)))
    @Test fun someoneJoiningYourMeetingRingsTheMeetingIn() = assertEquals(listOf(Cue.MeetingIn), soundCues(inRed(2), inRed(2, 3)))
    @Test fun someoneLeavingYourMeetingRingsTheMeetingOut() = assertEquals(listOf(Cue.MeetingOut), soundCues(inRed(2, 3), inRed(2)))

    // The web client keeps quiet once the group is bigger than five, so a crowd doesn't chime constantly.
    @Test fun aCrowdStaysQuietForOthersButYouStillHearYourOwnJoin() {
        assertEquals(emptyList(), soundCues(inRed(2, 3, 4, 5, 6), inRed(2, 3, 4, 5, 6, 7)))
        assertEquals(listOf(Cue.MeetingIn), soundCues(alone, inRed(2, 3, 4, 5, 6, 7)))
    }

    @Test fun movingFromOneConversationToAnotherLeavesThenJoins() =
        assertEquals(listOf(Cue.BubbleOut, Cue.MeetingIn), soundCues(inBubble(2), inRed(3)))
    @Test fun aBubbleYouAreNotInMakesNoSound() = assertEquals(emptyList(), soundCues(alone, alone.copy(groups = listOf(Group(9, 0, 0, listOf(2, 3))), players = listOf(player(2), player(3)))))
}
