package app.workadventurer.app.ui

import app.workadventurer.app.session.SessionState
import app.workadventurer.proto.PositionMessage
import app.workadventurer.protocol.Group
import app.workadventurer.protocol.Player
import kotlin.test.Test
import kotlin.test.assertEquals

// Someone who leaves stays in the list for a moment, dimmed, saying they left, so the list doesn't just jump (#134).
class LeaversTest {
    private fun player(id: Int, name: String) = Player(id, name, "u$id", 0, 0, PositionMessage.Direction.DOWN)
    private fun state(players: List<Player>, groups: List<Group> = emptyList()) =
        SessionState(players = players, groups = groups, myUserId = 1, myName = "Me")

    private val ada = player(2, "Ada")
    private val bo = player(3, "Bo")

    @Test
    fun someoneWhoWasThereAndIsNotAnyMoreIsHeldForAMoment() {
        val held = trackLeavers(state(listOf(ada, bo)), state(listOf(bo)), emptyMap(), nowMs = 1_000)
        assertEquals(setOf(2), held.keys)
        assertEquals(1_000 + LEAVER_HOLD_MS, held.getValue(2).until)
    }

    @Test
    fun noBeforeMeansNoLeavers() {
        assertEquals(emptyMap(), trackLeavers(null, state(listOf(bo)), emptyMap(), nowMs = 0))
    }

    @Test
    fun youAreNeverALeaver() {
        val me = player(1, "Me")
        assertEquals(emptyMap(), trackLeavers(state(listOf(me, bo)), state(listOf(bo)), emptyMap(), nowMs = 0))
    }

    @Test
    fun aLeaverIsLetGoOnceTheMomentIsUp() {
        val held = trackLeavers(state(listOf(ada)), state(emptyList()), emptyMap(), nowMs = 0)
        val still = trackLeavers(state(emptyList()), state(emptyList()), held, nowMs = LEAVER_HOLD_MS - 1)
        assertEquals(setOf(2), still.keys)
        val gone = trackLeavers(state(emptyList()), state(emptyList()), still, nowMs = LEAVER_HOLD_MS)
        assertEquals(emptyMap(), gone)
    }

    @Test
    fun someoneWhoComesBackIsNoLongerALeaver() {
        val held = trackLeavers(state(listOf(ada)), state(emptyList()), emptyMap(), nowMs = 0)
        assertEquals(emptyMap(), trackLeavers(state(emptyList()), state(listOf(ada)), held, nowMs = 10))
    }

    @Test
    fun theLeaverIsPutBackAmongThePlayersInTheirBubble() {
        val before = state(listOf(ada, bo), groups = listOf(Group(7, 0, 0, listOf(1, 2, 3))))
        val now = state(listOf(bo), groups = listOf(Group(7, 0, 0, listOf(1, 3))))
        val held = trackLeavers(before, now, emptyMap(), nowMs = 0)
        val shown = withLeavers(now, held)
        assertEquals(listOf("Ada", "Bo"), shown.players.map { it.name })
        assertEquals(listOf(1, 3, 2), shown.groups.single().userIds)
    }

    @Test
    fun aBubbleThatNoLongerExistsIsNotBroughtBack() {
        val before = state(listOf(ada, bo), groups = listOf(Group(7, 0, 0, listOf(2, 3))))
        val now = state(listOf(bo))
        val held = trackLeavers(before, now, emptyMap(), nowMs = 0)
        assertEquals(emptyList(), withLeavers(now, held).groups)
        assertEquals(listOf("Ada", "Bo"), withLeavers(now, held).players.map { it.name }) // still listed, just not in a bubble
    }

    // The list marks them, and the row says so.
    @Test
    fun theUsersListMarksWhoLeft() {
        val now = state(listOf(bo))
        val held = trackLeavers(state(listOf(ada, bo)), now, emptyMap(), nowMs = 0)
        val m = usersModel(withLeavers(now, held), left = held.keys)
        val ada = m.onMap.first { it.name == "Ada" }
        assertEquals(DISCONNECTED_TEXT, ada.leaving)
        assertEquals(null, m.onMap.first { it.name == "Bo" }.leaving)
        assertEquals("Disconnected…", DISCONNECTED_TEXT)
        assertEquals(0.5f, LEFT_ROOM_ALPHA)
    }

    // Walking out of the bubble or area you are looking at (but staying in the room) dims their row there too.
    private fun who(id: Int, name: String, me: Boolean = false, leaving: String? = null) =
        Participant(id, name, me, app.workadventurer.proto.AvailabilityStatus.ONLINE, emptyList(), leaving)
    private val meP = who(1, "Me", me = true)
    private val adaP = who(2, "Ada")
    private val boP = who(3, "Bo")

    @Test
    fun someoneWhoWalkedOutOfTheAreaIsHeldWithWhatHappened() {
        val held = trackWalkers(listOf(meP, adaP), listOf(meP), emptyMap(), nowMs = 1_000, noun = "area")
        assertEquals(setOf(2), held.keys)
        assertEquals("Left the area…", held.getValue(2).participant.leaving)
        assertEquals(1_000 + LEAVER_HOLD_MS, held.getValue(2).until)
        assertEquals("Left the bubble…", trackWalkers(listOf(meP, adaP), listOf(meP), emptyMap(), 0, "bubble").getValue(2).participant.leaving)
    }

    @Test
    fun youAndPeopleAlreadyLeavingTheRoomAreNotWalkers() {
        assertEquals(emptyMap(), trackWalkers(listOf(meP, adaP), listOf(adaP), emptyMap(), 0, "area")) // you
        assertEquals(emptyMap(), trackWalkers(listOf(meP, who(2, "Ada", leaving = DISCONNECTED_TEXT)), listOf(meP), emptyMap(), 0, "area"))
        assertEquals(emptyMap(), trackWalkers(null, listOf(meP), emptyMap(), 0, "area"))
    }

    @Test
    fun aWalkerGoesAfterTheMomentOrWhenTheyComeBack() {
        val held = trackWalkers(listOf(meP, adaP), listOf(meP), emptyMap(), 0, "area")
        assertEquals(setOf(2), trackWalkers(listOf(meP), listOf(meP), held, LEAVER_HOLD_MS - 1, "area").keys)
        assertEquals(emptyMap(), trackWalkers(listOf(meP), listOf(meP), held, LEAVER_HOLD_MS, "area"))
        assertEquals(emptyMap(), trackWalkers(listOf(meP), listOf(meP, adaP), held, 10, "area"))
    }

    @Test
    fun theWalkerIsShownDimmedInOrderYouFirst() {
        val held = trackWalkers(listOf(meP, adaP, boP), listOf(meP, boP), emptyMap(), 0, "area")
        val shown = withWalkers(listOf(meP, boP), held)
        assertEquals(listOf("Me", "Ada", "Bo"), shown.map { it.name })
        assertEquals(listOf(null, "Left the area…", null), shown.map { it.leaving })
    }
}
