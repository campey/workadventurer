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
 * everyone else ("Is on this map", you first), and every other area. Only people the server has told us about are listed
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

fun usersModel(s: SessionState): UsersModel {
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

    val meetings = s.areas.filter { it.isMeeting() }.sortedBy { it.name.lowercase() }.map { a -> a to occupants(a) }
    val populatedMeetings = meetings.filter { (_, o) -> o.isNotEmpty() }.map { (a, o) -> areaConversation(a, o) }
    val activeArea = if (activeBubble == null) populatedMeetings.firstOrNull { it.joined } else null

    val active = activeBubble ?: activeArea
    val bubbles = allBubbles.filter { it !== activeBubble }
    val meetingAreas = populatedMeetings.filter { it !== activeArea }

    // "Is on this map": everyone not listed under a bubble or a meeting area (so you appear once).
    val listed = (allBubbles + populatedMeetings).flatMap { c -> c.members.map { it.userId } }.toSet()
    val meListed = (allBubbles + populatedMeetings).any { c -> c.members.any { it.isMe } }
    val onMap = buildList {
        if (!meListed) add(me)
        addAll(others.values.filter { it.userId !in listed }.sortedWith(byName))
    }

    val populatedKeys = populatedMeetings.map { (it.key as ConversationKey.AreaKey).key }.toSet()
    val otherAreas = s.areas.filter { it.key() !in populatedKeys }.sortedBy { it.name.lowercase() }.map { AreaEntry(it, occupants(it)) }

    return UsersModel(active, bubbles, meetingAreas, onMap, otherAreas)
}
