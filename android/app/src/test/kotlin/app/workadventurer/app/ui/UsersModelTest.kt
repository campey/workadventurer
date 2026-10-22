package app.workadventurer.app.ui

import app.workadventurer.app.session.SessionState
import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.proto.PositionMessage
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.Group
import app.workadventurer.protocol.MeetingRoom
import app.workadventurer.protocol.Player
import app.workadventurer.protocol.Texture
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class UsersModelTest {
    private fun player(id: Int, name: String, x: Int = 0, y: Int = 0, status: AvailabilityStatus = AvailabilityStatus.ONLINE) =
        Player(id, name, "u$id", x, y, PositionMessage.Direction.DOWN, status)

    private fun area(id: String, name: String, x: Int, y: Int, meeting: Boolean = false) =
        Area(id, name, x, y, 100, 100, if (meeting) setOf("livekitRoomProperty") else emptySet(), false, false,
            if (meeting) MeetingRoom("p1", name) else null)

    private fun state(
        players: List<Player> = emptyList(), areas: List<Area> = emptyList(), inAreas: List<Area> = emptyList(),
        groups: List<Group> = emptyList(), myGroupId: Int? = null, myX: Int? = null, myY: Int? = null,
    ) = SessionState(
        players = players, areas = areas, inAreas = inAreas, groups = groups, myGroupId = myGroupId, myX = myX, myY = myY,
        myUserId = 1, myName = "Me", myTextures = listOf(Texture("t", "https://x/t.png")),
    )

    private fun names(c: List<Participant>) = c.map { it.name }

    @Test
    fun anEmptyRoomHasJustYouOnTheMap() {
        val m = usersModel(state())
        assertNull(m.active)
        assertEquals(listOf("Me"), names(m.onMap))
        assertEquals(true, m.onMap.single().isMe)
        assertEquals(listOf(Texture("t", "https://x/t.png")), m.onMap.single().textures)
    }

    @Test
    fun peopleOnTheMapAreYouFirstThenByNameIgnoringCase() {
        val m = usersModel(state(players = listOf(player(3, "bo"), player(2, "Ada"), player(4, "Cy"))))
        assertEquals(listOf("Me", "Ada", "bo", "Cy"), names(m.onMap))
    }

    @Test
    fun aBubbleIsTitledBubbleAndListsItsKnownMembers() {
        val m = usersModel(state(
            players = listOf(player(2, "Ada"), player(3, "Bo"), player(4, "Cy")),
            groups = listOf(Group(5, 10, 10, listOf(2, 3, 99))), // 99 is outside our view: not listed
        ))
        val b = m.bubbles.single()
        assertEquals("🫧 bubble", b.title)
        assertEquals(listOf("Ada", "Bo"), names(b.members))
        assertEquals(ConversationKey.Bubble(5), b.key)
        assertEquals(false, b.joined)
        assertEquals(listOf("Me", "Cy"), names(m.onMap)) // Ada and Bo are listed under the bubble, not twice
    }

    @Test
    fun twoBubblesAreEachTitledBubbleAndOrderedByGroup() {
        val m = usersModel(state(
            players = listOf(player(2, "Ada"), player(3, "Bo")),
            groups = listOf(Group(9, 0, 0, listOf(3)), Group(4, 0, 0, listOf(2))),
        ))
        assertEquals(listOf(4, 9), m.bubbles.map { (it.key as ConversationKey.Bubble).groupId })
        assertEquals(listOf("🫧 bubble", "🫧 bubble"), m.bubbles.map { it.title })
    }

    @Test
    fun aBubbleWithNobodyWeKnowIsNotListed() {
        val m = usersModel(state(groups = listOf(Group(5, 0, 0, listOf(98, 99)))))
        assertEquals(emptyList(), m.bubbles)
    }

    @Test
    fun theBubbleWeAreInIsActiveAndShowsYouInIt() {
        val m = usersModel(state(
            players = listOf(player(2, "Ada")),
            groups = listOf(Group(5, 0, 0, listOf(1, 2))),
            myGroupId = 5,
        ))
        val a = m.active!!
        assertEquals("🫧 bubble", a.title)
        assertEquals(true, a.joined)
        assertEquals(listOf("Me", "Ada"), names(a.members)) // you first
        assertEquals(emptyList(), m.bubbles) // not repeated further down
        assertEquals(emptyList(), m.onMap) // you are in the conversation, not on the bare map
    }

    @Test
    fun aMeetingAreaWithSomeoneInItIsPopulatedAndAnEmptyOneIsNot() {
        val table = area("t1", "Coffee table", 0, 0, meeting = true)
        val quiet = area("t2", "Quiet table", 500, 0, meeting = true)
        val m = usersModel(state(players = listOf(player(2, "Ada", x = 50, y = 50), player(3, "Bo", x = 900, y = 900)), areas = listOf(table, quiet)))
        assertEquals(listOf("Coffee table"), m.meetingAreas.map { it.title })
        assertEquals(listOf("Ada"), names(m.meetingAreas.single().members))
        assertEquals(ConversationKey.AreaKey("t1"), m.meetingAreas.single().key)
        assertEquals(listOf("Quiet table"), m.otherAreas.map { it.area.name })
        assertEquals(emptyList(), m.otherAreas.single().occupants)
        assertEquals(listOf("Me", "Bo"), names(m.onMap)) // Ada is listed under the table
    }

    @Test
    fun aMeetingAreaWeStandInIsActiveWhenWeAreInNoBubble() {
        val table = area("t1", "Coffee table", 0, 0, meeting = true)
        val m = usersModel(state(players = listOf(player(2, "Ada", x = 50, y = 50)), areas = listOf(table), inAreas = listOf(table)))
        val a = m.active!!
        assertEquals("Coffee table", a.title)
        assertEquals(true, a.joined)
        assertEquals(listOf("Me", "Ada"), names(a.members))
        assertEquals(emptyList(), m.meetingAreas)
    }

    @Test
    fun theBubbleWinsOverAMeetingAreaWeAlsoStandIn() {
        val table = area("t1", "Coffee table", 0, 0, meeting = true)
        val m = usersModel(state(
            players = listOf(player(2, "Ada", x = 50, y = 50)), areas = listOf(table), inAreas = listOf(table),
            groups = listOf(Group(5, 0, 0, listOf(1, 2))), myGroupId = 5,
        ))
        assertEquals("🫧 bubble", m.active!!.title)
        assertEquals(listOf("Coffee table"), m.meetingAreas.map { it.title }) // still listed with its people
    }

    @Test
    fun aPlainAreaStandingInItIsNotAConversation() {
        val spawn = area("s", "Spawn Point", 0, 0)
        val m = usersModel(state(players = listOf(player(2, "Ada", x = 50, y = 50)), areas = listOf(spawn), inAreas = listOf(spawn)))
        assertNull(m.active)
        assertEquals(emptyList(), m.meetingAreas)
        assertEquals(listOf("Spawn Point"), m.otherAreas.map { it.area.name })
        assertEquals(listOf("Me", "Ada"), names(m.otherAreas.single().occupants)) // people (you too) are shown under their area...
        assertEquals(emptyList(), names(m.onMap)) // ...and not again under "Elsewhere on the map" (#158)
    }

    @Test
    fun onlyPeopleInNoAreaAreElsewhereOnTheMap() {
        val spawn = area("s", "Spawn Point", 0, 0)
        val m = usersModel(state(players = listOf(player(2, "Barry", x = 50, y = 50), player(3, "Cara", x = 5000, y = 5000)), areas = listOf(spawn)))
        assertEquals(listOf("Barry"), names(m.otherAreas.single().occupants))
        assertEquals(listOf("Me", "Cara"), names(m.onMap)) // Barry is in Spawn Point, so not here too
    }

    @Test
    fun otherAreasAreEveryAreaByName() {
        val m = usersModel(state(areas = listOf(area("b", "beta", 0, 0), area("a", "Alpha", 200, 0), area("c", "(unnamed)", 400, 0))))
        assertEquals(listOf("(unnamed)", "Alpha", "beta"), m.otherAreas.map { it.area.name })
    }

    @Test
    fun theStatusAndTexturesTravelWithEachParticipant() {
        val p = Player(2, "Ada", "u2", 0, 0, PositionMessage.Direction.DOWN, AvailabilityStatus.BUSY, listOf(Texture("b", "https://x/b.png")))
        val x = usersModel(state(players = listOf(p))).onMap.last()
        assertEquals(AvailabilityStatus.BUSY, x.status)
        assertEquals(listOf(Texture("b", "https://x/b.png")), x.textures)
        assertEquals(2, x.userId)
        assertEquals(false, x.isMe)
    }

    // #159: populated first, then how often you have been there, then how near, then by name.
    private fun orderOf(vararg areas: Area, players: List<Player> = emptyList(), visits: Map<String, Int> = emptyMap(), myX: Int? = 0, myY: Int? = 0) =
        usersModel(state(players = players, areas = areas.toList(), myX = myX, myY = myY), visits).otherAreas.map { it.area.name }

    @Test
    fun populatedAreasComeFirstThenMostVisitedThenNearestThenByName() {
        val near = area("near", "Near", 100, 0)
        val far = area("far", "Far", 3000, 0)
        val busy = area("busy", "Busy", 6000, 0) // far away but someone is in it
        val people = listOf(player(2, "Ada", x = 6050, y = 50))
        assertEquals(listOf("Busy", "Near", "Far"), orderOf(near, far, busy, players = people)) // populated, then nearest
        assertEquals(listOf("Busy", "Far", "Near"), orderOf(near, far, busy, players = people, visits = mapOf("far" to 3, "near" to 1))) // then visits
    }

    @Test
    fun withEqualVisitsTheNearerAreaComesFirst() {
        val near = area("near", "Zed", 100, 0)
        val far = area("far", "Alpha", 3000, 0)
        assertEquals(listOf("Zed", "Alpha"), orderOf(near, far, visits = mapOf("near" to 2, "far" to 2)))
        assertEquals(listOf("Alpha", "Zed"), orderOf(near, far, myX = 3000, myY = 0)) // standing by Alpha now
    }

    @Test
    fun withNoPositionAndNoVisitsTheOrderIsByName() {
        assertEquals(listOf("Alpha", "Zed"), orderOf(area("z", "Zed", 0, 0), area("a", "Alpha", 3000, 0), myX = null, myY = null))
    }

    @Test
    fun theMeetingAreasWithPeopleAreOrderedTheSameWay() {
        val a = area("a", "Alpha", 3000, 0, meeting = true)
        val b = area("b", "Beta", 100, 0, meeting = true)
        val people = listOf(player(2, "Ada", x = 3050, y = 50), player(3, "Bob", x = 150, y = 50))
        fun order(visits: Map<String, Int>) = usersModel(state(players = people, areas = listOf(a, b), myX = 0, myY = 0), visits).meetingAreas.map { it.title }
        assertEquals(listOf("Beta", "Alpha"), order(emptyMap())) // nearest first
        assertEquals(listOf("Alpha", "Beta"), order(mapOf("a" to 4))) // but where you go often comes first
    }
}
