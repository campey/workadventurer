package app.workadventurer.app.ui

import app.workadventurer.app.session.SessionState
import app.workadventurer.proto.PositionMessage
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.Group
import app.workadventurer.protocol.MeetingRoom
import app.workadventurer.protocol.Player
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WhereaboutsTest {
    private fun player(id: Int, name: String, x: Int = 5000, y: Int = 5000) =
        Player(id, name, "u$id", x, y, PositionMessage.Direction.DOWN)

    private fun area(id: String, name: String, x: Int, y: Int, meeting: Boolean) =
        Area(id, name, x, y, 100, 100, if (meeting) setOf("livekitRoomProperty") else emptySet(), false, false, if (meeting) MeetingRoom("p", name) else null)

    private fun state(
        players: List<Player>, areas: List<Area> = emptyList(), inAreas: List<Area> = emptyList(),
        groups: List<Group> = emptyList(), myGroupId: Int? = null,
    ) = SessionState(players = players, areas = areas, inAreas = inAreas, groups = groups, myGroupId = myGroupId, myUserId = 1, myName = "Me")

    @Test
    fun someoneInABubbleWithOthers() {
        val s = state(listOf(player(2, "Maya"), player(3, "Sam")), groups = listOf(Group(5, 0, 0, listOf(2, 3))))
        val w = whereIs(2, s)
        assertEquals(Whereabouts.InBubble(ConversationKey.Bubble(5), others = listOf("Sam"), withYou = false), w)
        assertEquals("In a bubble with Sam", whereText(w))
        assertEquals("Go to them and join the conversation", walkExplainer(w))
    }

    @Test
    fun someoneInYourOwnBubbleIsWithYou() {
        val s = state(listOf(player(2, "Maya"), player(3, "Sam")), groups = listOf(Group(5, 0, 0, listOf(1, 2, 3))), myGroupId = 5)
        val w = whereIs(2, s)
        assertEquals(Whereabouts.InBubble(ConversationKey.Bubble(5), others = listOf("Sam"), withYou = true), w)
        assertEquals("In this bubble with you and Sam", whereText(w))
        assertEquals(true, w.isTogether())
        assertNull(walkExplainer(w)) // you are already together: nothing to walk to
    }

    @Test
    fun aBubbleOfTwoWithYou() {
        val s = state(listOf(player(2, "Maya")), groups = listOf(Group(5, 0, 0, listOf(1, 2))), myGroupId = 5)
        assertEquals("In this bubble with you", whereText(whereIs(2, s)))
    }

    @Test
    fun threeOthersAreListedWithAnd() {
        val s = state(listOf(player(2, "A"), player(3, "B"), player(4, "C"), player(6, "D")), groups = listOf(Group(5, 0, 0, listOf(2, 3, 4, 6))))
        assertEquals("In a bubble with B, C and D", whereText(whereIs(2, s)))
    }

    @Test
    fun aBubbleMemberWeCannotSeeIsNotNamed() {
        val s = state(listOf(player(2, "Maya")), groups = listOf(Group(5, 0, 0, listOf(2, 99))))
        assertEquals("In a bubble", whereText(whereIs(2, s)))
    }

    @Test
    fun someoneInAMeetingAreaWithAnother() {
        val table = area("t1", "Coffee table 1", 0, 0, meeting = true)
        val s = state(listOf(player(2, "Priya", 50, 50), player(3, "Tom", 60, 60)), areas = listOf(table))
        val w = whereIs(2, s)
        assertEquals(Whereabouts.InArea(ConversationKey.AreaKey("t1"), "Coffee table 1", meeting = true, others = listOf("Tom"), withYou = false), w)
        assertEquals("In Coffee table 1 with Tom", whereText(w))
        assertEquals("Go to them and join the conversation", walkExplainer(w))
    }

    // Alone in a meeting area there is nobody to join, so it reads like being on their own.
    @Test
    fun aloneInAMeetingAreaStartsAConversation() {
        val table = area("t1", "Coffee table 1", 0, 0, meeting = true)
        val w = whereIs(2, state(listOf(player(2, "Priya", 50, 50)), areas = listOf(table)))
        assertEquals("In Coffee table 1", whereText(w))
        assertEquals("Go to them and start a conversation", walkExplainer(w))
    }

    @Test
    fun someoneWithYouInAMeetingArea() {
        val table = area("t1", "Coffee table 1", 0, 0, meeting = true)
        val s = state(listOf(player(2, "Priya", 50, 50)), areas = listOf(table), inAreas = listOf(table))
        val w = whereIs(2, s)
        assertEquals("In Coffee table 1 with you", whereText(w))
        assertEquals(true, w.isTogether())
    }

    // Together in an area it still says which area, unlike a bubble, which has no name.
    @Test
    fun someoneWithYouAndAnotherInAMeetingAreaNamesTheArea() {
        val table = area("t1", "Coffee table 1", 0, 0, meeting = true)
        val s = state(listOf(player(2, "Priya", 50, 50), player(3, "Tom", 60, 60)), areas = listOf(table), inAreas = listOf(table))
        assertEquals("In Coffee table 1 with you and Tom", whereText(whereIs(2, s)))
    }

    // Your own screen: the same facts from your side.
    @Test
    fun youInABubbleAreWithTheOthersInIt() {
        val s = state(listOf(player(2, "Maya"), player(3, "Sam")), groups = listOf(Group(5, 0, 0, listOf(1, 2, 3))), myGroupId = 5)
        val w = whereAmI(s)
        assertEquals(Whereabouts.InBubble(ConversationKey.Bubble(5), others = listOf("Maya", "Sam"), withYou = true), w)
        assertEquals("In a bubble with Maya and Sam", whereTextForMe(w))
        assertEquals(ConversationKey.Bubble(5), w.conversation())
    }

    @Test
    fun youInAMeetingAreaNameItAndTheOthersThere() {
        val table = area("t1", "Coffee table 1", 0, 0, meeting = true)
        val s = state(listOf(player(2, "Priya", 50, 50), player(3, "Tom", 5000, 5000)), areas = listOf(table), inAreas = listOf(table))
        val w = whereAmI(s)
        assertEquals("In Coffee table 1 with Priya", whereTextForMe(w))
        assertEquals(ConversationKey.AreaKey("t1"), w.conversation())
    }

    @Test
    fun youAloneInAMeetingAreaOrAPlainArea() {
        val table = area("t1", "Coffee table 1", 0, 0, meeting = true)
        assertEquals("In Coffee table 1", whereTextForMe(whereAmI(state(emptyList(), areas = listOf(table), inAreas = listOf(table)))))
        val spawn = area("s", "Spawn Point", 0, 0, meeting = false)
        val w = whereAmI(state(emptyList(), areas = listOf(spawn), inAreas = listOf(spawn)))
        assertEquals("In Spawn Point, on your own", whereTextForMe(w))
        assertNull(w.conversation())
    }

    @Test
    fun youOnTheOpenMap() {
        val w = whereAmI(state(listOf(player(2, "Noor"))))
        assertEquals(Whereabouts.OnTheMap, w)
        assertEquals("On the map, on your own", whereTextForMe(w))
    }

    @Test
    fun aJitsiAreaIsNamedForYouToo() {
        val room = Area("j", "Jitsi room", 0, 0, 100, 100, setOf("jitsiRoomProperty"), false, false, null)
        assertEquals("In Jitsi room (Jitsi meeting)", whereTextForMe(whereAmI(state(emptyList(), areas = listOf(room), inAreas = listOf(room)))))
    }

    @Test
    fun aPlainAreaIsJustWhereTheyAre() {
        val spawn = area("s", "Spawn Point", 0, 0, meeting = false)
        val w = whereIs(2, state(listOf(player(2, "Lee", 50, 50)), areas = listOf(spawn)))
        assertEquals("In Spawn Point, on their own", whereText(w))
        assertEquals("Go to them and start a conversation", walkExplainer(w))
        assertEquals(false, w.isTogether())
    }

    @Test
    fun aBubbleBeatsTheAreaTheyAreStandingIn() {
        val table = area("t1", "Coffee table 1", 0, 0, meeting = true)
        val s = state(listOf(player(2, "Priya", 50, 50), player(3, "Tom", 60, 60)), areas = listOf(table), groups = listOf(Group(5, 0, 0, listOf(2, 3))))
        assertEquals("In a bubble with Tom", whereText(whereIs(2, s)))
    }

    @Test
    fun aloneOnTheMap() {
        val w = whereIs(2, state(listOf(player(2, "Noor"))))
        assertEquals(Whereabouts.OnTheMap, w)
        assertEquals("On the map, on their own", whereText(w))
        assertEquals("Go to them and start a conversation", walkExplainer(w))
    }

    @Test
    fun nobodyWeDoNotKnowIsAnywhere() {
        assertNull(whereIsOrNull(99, state(listOf(player(2, "Noor")))))
    }

    // The "Right now" row opens the conversation they are in; a plain area or the open map has none.
    @Test
    fun theRightNowRowOpensABubbleOrAMeetingAreaButNotAPlainAreaOrTheMap() {
        val bubble = state(listOf(player(2, "Maya"), player(3, "Sam")), groups = listOf(Group(5, 0, 0, listOf(2, 3))))
        assertEquals(ConversationKey.Bubble(5), whereIs(2, bubble).conversation())

        val meeting = area("m", "Red Table", 0, 0, meeting = true)
        val plain = area("p", "Spawn", 0, 0, meeting = false)
        assertEquals(ConversationKey.AreaKey("m"), whereIs(2, state(listOf(player(2, "Maya", 50, 50)), areas = listOf(meeting))).conversation())
        assertNull(whereIs(2, state(listOf(player(2, "Maya", 50, 50)), areas = listOf(plain))).conversation())
        assertNull(whereIs(2, state(listOf(player(2, "Maya")))).conversation())
    }

    @Test
    fun togetherSaysWhichKindOfConversationYouShare() {
        val bubble = state(listOf(player(2, "Maya")), groups = listOf(Group(5, 0, 0, listOf(1, 2))), myGroupId = 5)
        assertEquals("You are already in this bubble together", togetherNote(whereIs(2, bubble)))
        val meeting = area("m", "Red Table", 0, 0, meeting = true)
        val inArea = state(listOf(player(2, "Maya", 50, 50)), areas = listOf(meeting), inAreas = listOf(meeting))
        assertEquals("You are already in Red Table together", togetherNote(whereIs(2, inArea)))
        assertNull(togetherNote(Whereabouts.OnTheMap))
    }
}
