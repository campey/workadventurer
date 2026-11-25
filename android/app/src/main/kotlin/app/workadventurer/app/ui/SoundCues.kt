package app.workadventurer.app.ui

import app.workadventurer.app.session.SessionState

/** The chimes the web client plays (ProximityChatRoom, v1.35.1): one pair for a bubble, one for a meeting area. */
enum class Cue { BubbleIn, BubbleOut, MeetingIn, MeetingOut }

/** Like the web client, others coming and going stay silent once the conversation is bigger than this. */
const val MAX_PEOPLE_FOR_CUES = 5

private fun Conversation.isBubble() = key is ConversationKey.Bubble
private fun Conversation.cueIn() = if (isBubble()) Cue.BubbleIn else Cue.MeetingIn
private fun Conversation.cueOut() = if (isBubble()) Cue.BubbleOut else Cue.MeetingOut
private fun Conversation.others() = members.filter { !it.isMe }.mapNotNull { it.userId }.toSet()

/**
 * What to play for the change from [before] to [after]: you joining or leaving a conversation, or someone else joining or
 * leaving the one you are in (quiet once it holds more than [MAX_PEOPLE_FOR_CUES]). The same rules as the web client.
 */
fun soundCues(before: SessionState?, after: SessionState): List<Cue> {
    before ?: return emptyList()
    val b = usersModel(before).active
    val a = usersModel(after).active
    return when {
        b == null && a == null -> emptyList()
        b == null -> listOf(a!!.cueIn())
        a == null -> listOf(b.cueOut())
        b.key != a.key -> listOf(b.cueOut(), a.cueIn())
        a.members.size > MAX_PEOPLE_FOR_CUES -> emptyList()
        else -> buildList {
            if ((a.others() - b.others()).isNotEmpty()) add(a.cueIn())
            if ((b.others() - a.others()).isNotEmpty()) add(a.cueOut())
        }
    }
}
