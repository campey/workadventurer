package app.workadventurer.app.ui

import app.workadventurer.app.session.SessionState

/** Where a person is right now, for their screen: in a bubble, in an area, or on the map. [others] are names we can see. */
sealed interface Whereabouts {
    data class InBubble(val key: ConversationKey.Bubble, val others: List<String>, val withYou: Boolean) : Whereabouts
    data class InArea(val key: ConversationKey.AreaKey, val areaName: String, val meeting: Boolean, val others: List<String>, val withYou: Boolean) : Whereabouts
    data object OnTheMap : Whereabouts

    /** You are in the same conversation as them (a bubble, or a meeting area), so there is nothing to walk to. */
    fun isTogether(): Boolean = when (this) {
        is InBubble -> withYou
        is InArea -> meeting && withYou
        OnTheMap -> false
    }
}

/** Where [userId] is, or null for somebody we don't know about. A bubble beats a meeting area, which beats a plain area. */
fun whereIsOrNull(userId: Int, s: SessionState): Whereabouts? {
    val person = s.players.firstOrNull { it.userId == userId } ?: return null
    val names = s.players.associate { it.userId to it.name }

    val bubble = s.groups.sortedBy { it.groupId }.firstOrNull { userId in it.userIds }
    if (bubble != null) {
        val others = bubble.userIds.filter { it != userId && it != s.myUserId }.mapNotNull { names[it] }.sortedBy { it.lowercase() }
        return Whereabouts.InBubble(ConversationKey.Bubble(bubble.groupId), others, withYou = s.myUserId != null && s.myUserId in bubble.userIds)
    }

    val areas = s.areas.filter { it.contains(person.x, person.y) }.sortedBy { it.name.lowercase() }
    val area = areas.firstOrNull { it.isMeeting() } ?: areas.firstOrNull()
    if (area != null) {
        val key = area.id ?: area.name
        val others = s.players.filter { it.userId != userId && area.contains(it.x, it.y) }.map { it.name }.sortedBy { it.lowercase() }
        return Whereabouts.InArea(
            ConversationKey.AreaKey(key), area.name, area.isMeeting(), others,
            withYou = s.inAreas.any { (it.id ?: it.name) == key },
        )
    }
    return Whereabouts.OnTheMap
}

fun whereIs(userId: Int, s: SessionState): Whereabouts = whereIsOrNull(userId, s) ?: Whereabouts.OnTheMap

/** "A", "A and B", "A, B and C". */
private fun naturalList(items: List<String>): String = when (items.size) {
    0 -> ""
    1 -> items[0]
    else -> items.dropLast(1).joinToString(", ") + " and " + items.last()
}

/** The "Right now" line on a person's screen. */
fun whereText(w: Whereabouts): String = when (w) {
    is Whereabouts.InBubble -> when {
        w.withYou -> "In this bubble with " + naturalList(listOf("you") + w.others)
        w.others.isEmpty() -> "In a bubble"
        else -> "In a bubble with " + naturalList(w.others)
    }
    is Whereabouts.InArea -> when {
        w.meeting && w.withYou -> "In this area with " + naturalList(listOf("you") + w.others)
        w.meeting -> if (w.others.isEmpty()) "In ${w.areaName}" else "In ${w.areaName} with " + naturalList(w.others)
        else -> {
            val company = (if (w.withYou) listOf("you") else emptyList()) + w.others
            if (company.isEmpty()) "In ${w.areaName}, on their own" else "In ${w.areaName} with " + naturalList(company)
        }
    }
    Whereabouts.OnTheMap -> "On the map, on their own"
}

/** What walking over to them does, under the Walk over button; null when you are already together. */
fun walkExplainer(w: Whereabouts): String? = when {
    w.isTogether() -> null
    w is Whereabouts.InBubble -> "Go to them and join the conversation"
    w is Whereabouts.InArea && w.meeting && w.others.isNotEmpty() -> "Go to them and join the conversation"
    else -> "Go to them and start a conversation"
}
