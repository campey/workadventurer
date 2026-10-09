package app.workadventurer.app.ui

import app.workadventurer.app.session.Activity
import app.workadventurer.app.session.SessionState
import app.workadventurer.proto.PositionMessage
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.Group
import app.workadventurer.protocol.MeetingRoom
import app.workadventurer.protocol.Player
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ConversationModelTest {
    private fun player(id: Int, name: String, x: Int = 500, y: Int = 500) = Player(id, name, "u$id", x, y, PositionMessage.Direction.DOWN)
    private fun area(id: String, name: String, props: Set<String>, meeting: Boolean) =
        Area(id, name, 0, 0, 100, 100, props, false, false, if (meeting) MeetingRoom("p", name) else null)

    private val red = area("red", "Red Table", setOf("livekitRoomProperty"), meeting = true)
    private val jitsi = area("j", "Right Board Room", setOf("jitsiRoomProperty"), meeting = false)
    private val bubbleKey = ConversationKey.Bubble(3)
    private val areaKey = ConversationKey.AreaKey("red")

    private fun state(
        players: List<Player> = emptyList(), areas: List<Area> = listOf(red, jitsi), inAreas: List<Area> = emptyList(),
        groups: List<Group> = emptyList(), myGroupId: Int? = null, activity: Activity = Activity.Idle,
    ) = SessionState(players = players, areas = areas, inAreas = inAreas, groups = groups, myGroupId = myGroupId, activity = activity, myUserId = 1, myName = "Me")

    @Test
    fun aBubbleYouAreNotInOffersToJoinIt() {
        val m = conversationScreen(bubbleKey, state(players = listOf(player(2, "Ada")), groups = listOf(Group(3, 5, 5, listOf(2)))))!!
        assertEquals(Phase.CanJoin, m.phase)
        assertEquals("You are not in this bubble", m.strip)
        assertEquals("Join the bubble", m.joinLabel)
        assertEquals("Walk your avatar over to talk to them", m.explainer)
        assertEquals(listOf("Ada"), m.members.map { it.name })
    }

    @Test
    fun walkingOverToABubbleIsShownWhileTheWalkIsOn() {
        val m = conversationScreen(bubbleKey, state(players = listOf(player(2, "Ada")), groups = listOf(Group(3, 5, 5, listOf(2))), activity = Activity.WalkingTo("Ada")))!!
        assertEquals(Phase.Walking, m.phase)
    }

    @Test
    fun beingInABubbleWithOthersIsTalkingInIt() {
        val m = conversationScreen(bubbleKey, state(players = listOf(player(2, "Ada")), groups = listOf(Group(3, 5, 5, listOf(1, 2))), myGroupId = 3))!!
        assertEquals(Phase.Joined, m.phase)
        assertEquals("You are in this bubble", m.strip)
        assertEquals("Talking in the bubble", m.subtext)
        assertEquals("Leave the bubble", m.leaveLabel)
        assertEquals("Walk your avatar out of the bubble", m.leaveExplainer)
    }

    @Test
    fun anAreaToJoinSaysWalkIntoIt() {
        val m = conversationScreen(areaKey, state(players = listOf(player(2, "Ada", 50, 50))))!!
        assertEquals(Phase.CanJoin, m.phase)
        assertEquals("Join the area", m.joinLabel)
        assertEquals("Walk your avatar into the area to talk to them", m.explainer)
        assertEquals("You are not in this area", m.strip)
    }

    @Test
    fun walkingIntoAnAreaIsTheWalkLabelledWithItsName() {
        assertEquals(Phase.Walking, conversationScreen(areaKey, state(activity = Activity.WalkingTo("Red Table")))!!.phase)
        assertEquals(Phase.CanJoin, conversationScreen(areaKey, state(activity = Activity.WalkingTo("Somewhere else")))!!.phase)
    }

    @Test
    fun beingAloneInAnAreaIsWaiting_andAnEmptyOneSaysSo() {
        val alone = conversationScreen(areaKey, state(inAreas = listOf(red)))!!
        assertEquals(Phase.Joined, alone.phase)
        assertEquals("Waiting in Red Table", alone.subtext)
        val withOthers = conversationScreen(areaKey, state(inAreas = listOf(red), players = listOf(player(2, "Ada", 50, 50))))!!
        assertEquals("Talking in Red Table", withOthers.subtext)
        val empty = conversationScreen(areaKey, state())!!
        assertEquals("Nobody is here yet", empty.emptyText)
        assertNull(withOthers.emptyText)
    }

    @Test
    fun walkingOutIsShownAsLeaving() {
        val m = conversationScreen(areaKey, state(inAreas = listOf(red), activity = Activity.WalkingOut("Red Table")))!!
        assertEquals(Phase.Leaving, m.phase)
    }

    @Test
    fun aJitsiAreaCannotBeJoined() {
        val m = conversationScreen(ConversationKey.AreaKey("j"), state())!!
        assertEquals(Phase.Jitsi, m.phase)
        assertEquals("Join in Jitsi", m.joinLabel)
        assertEquals(JITSI_NOT_SUPPORTED_MESSAGE, m.explainer)
    }

    @Test
    fun aBubbleThatIsGoneHasNoScreen() {
        assertNull(conversationScreen(bubbleKey, state()))
        assertNull(conversationScreen(ConversationKey.AreaKey("nope"), state()))
    }
}
