package app.workadventurer.app.ui

import app.workadventurer.app.session.SessionState
import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.Texture

/** Someone in the room as the Users screen shows them. [userId] is null for nobody we can act on. */
data class Participant(
    val userId: Int?,
    val name: String,
    val isMe: Boolean,
    val status: AvailabilityStatus,
    val textures: List<Texture>,
)

/** What a conversation screen is about: a proximity bubble (by group id) or a map area (by `id ?: name`, as `WalkToArea`). */
sealed interface ConversationKey {
    data class Bubble(val groupId: Int) : ConversationKey
    data class AreaKey(val key: String) : ConversationKey
}

/** A bubble or a meeting area with the people in it. [joined] means we are in it right now. */
data class Conversation(val key: ConversationKey, val title: String, val members: List<Participant>, val joined: Boolean)

/** An area that is not a populated meeting: [occupants] are the people standing in it (they are also on the map list). */
data class AreaEntry(val area: Area, val occupants: List<Participant>)

/**
 * The Users screen's sections, top to bottom: the conversation we are in, other bubbles, meeting areas with people in them,
 * everyone else ("Elsewhere on the map", you first), and every other area. Only people the server has told us about are listed
 * (it streams those near us), so a bubble none of whose members we know is left out.
 */
data class UsersModel(
    val active: Conversation?,
    val bubbles: List<Conversation>,
    val meetingAreas: List<Conversation>,
    val onMap: List<Participant>,
    val otherAreas: List<AreaEntry>,
)

const val BUBBLE_TITLE = "🫧 bubble"

private fun Area.key() = id ?: name

/** An area you can talk in: a LiveKit meeting room, or a Jitsi one. */
fun Area.isMeeting() = meetingRoom != null || "jitsiRoomProperty" in propertyTypes

/**
 * How the areas are ordered (#159): ones with people first, then the ones you go to most ([visits], by area key), then the
 * nearest to where you stand, then by name. Without a known position distance doesn't decide anything.
 */
private fun areaOrder(s: SessionState, visits: Map<String, Int>, populated: (Area) -> Boolean): Comparator<Area> {
    fun distance(a: Area): Double {
        val x = s.myX ?: return 0.0
        val y = s.myY ?: return 0.0
        return Math.hypot(a.x + a.w / 2.0 - x, a.y + a.h / 2.0 - y)
    }
    return compareBy<Area>({ !populated(it) }, { -(visits[it.key()] ?: 0) }, { distance(it) }, { it.name.lowercase() })
}

fun usersModel(s: SessionState, visits: Map<String, Int> = emptyMap()): UsersModel {
    val me = Participant(s.myUserId, s.myName.ifBlank { "You" }, true, AvailabilityStatus.ONLINE, s.myTextures)
    val others = s.players.associateBy { it.userId }.mapValues { (_, p) ->
        Participant(p.userId, p.name, false, p.availabilityStatus, p.textures)
    }
    val byName = compareBy<Participant>({ it.name.lowercase() }, { it.userId })

    // Bubbles: members we know; us first when we are in it.
    fun bubble(g: app.workadventurer.protocol.Group): Conversation {
        val members = g.userIds.mapNotNull { id -> if (id == s.myUserId) me else others[id] }
        return Conversation(
            ConversationKey.Bubble(g.groupId), BUBBLE_TITLE,
            members.sortedWith(compareBy<Participant> { !it.isMe }.then(byName)), joined = g.groupId == s.myGroupId,
        )
    }
    val allBubbles = s.groups.sortedBy { it.groupId }.map(::bubble).filter { it.members.isNotEmpty() }
    val activeBubble = allBubbles.firstOrNull { it.joined }

    // Areas: who is standing inside (people we know about, plus us).
    fun occupants(a: Area): List<Participant> {
        val inside = s.players.filter { a.contains(it.x, it.y) }.map { others.getValue(it.userId) }
        val withMe = if (s.inAreas.any { it.key() == a.key() }) listOf(me) + inside else inside
        return withMe.sortedWith(compareBy<Participant> { !it.isMe }.then(byName))
    }
    fun areaConversation(a: Area, members: List<Participant>) = Conversation(
        ConversationKey.AreaKey(a.key()), a.name, members, joined = s.inAreas.any { it.key() == a.key() },
    )

    val meetings = s.areas.filter { it.isMeeting() }.sortedWith(areaOrder(s, visits) { occupants(it).isNotEmpty() }).map { a -> a to occupants(a) }
    val populatedMeetings = meetings.filter { (_, o) -> o.isNotEmpty() }.map { (a, o) -> areaConversation(a, o) }
    val activeArea = if (activeBubble == null) populatedMeetings.firstOrNull { it.joined } else null

    val active = activeBubble ?: activeArea
    val bubbles = allBubbles.filter { it !== activeBubble }
    val meetingAreas = populatedMeetings.filter { it !== activeArea }

    // "Elsewhere on the map": everyone not listed under a bubble, a meeting area or an area (so each person appears once).
    val listed = (allBubbles + populatedMeetings).flatMap { c -> c.members.map { it.userId } }.toSet()
    val meListed = (allBubbles + populatedMeetings).any { c -> c.members.any { it.isMe } }
    // Anyone standing in an area is listed under that area, so not here as well (#158).
    val inAnArea = s.players.filter { p -> s.areas.any { it.contains(p.x, p.y) } }.map { it.userId }.toSet()
    val onMap = buildList {
        if (!meListed && s.inAreas.isEmpty()) add(me)
        addAll(others.values.filter { it.userId !in listed && it.userId !in inAnArea }.sortedWith(byName))
    }

    val populatedKeys = populatedMeetings.map { (it.key as ConversationKey.AreaKey).key }.toSet()
    val otherAreas = s.areas.filter { it.key() !in populatedKeys }.sortedWith(areaOrder(s, visits) { occupants(it).isNotEmpty() }).map { AreaEntry(it, occupants(it)) }

    return UsersModel(active, bubbles, meetingAreas, onMap, otherAreas)
}
