package app.workadventurer.app.ui

import app.workadventurer.app.session.Activity
import app.workadventurer.app.session.SessionState

/** Where the conversation screen's action is: join, on the way, in it, on the way out, or a Jitsi area we cannot join. */
enum class Phase { CanJoin, Walking, Joined, Leaving, Jitsi }

/**
 * What the screen for one bubble or area shows. Joining and leaving are done by walking (the protocol has no message for
 * either), so [phase] follows the avatar's walk and where it is.
 */
data class ConversationScreenModel(
    val title: String,
    val noun: String, // "bubble" or "area"
    val members: List<Participant>,
    val phase: Phase,
    val strip: String,
    val joinLabel: String,
    val explainer: String,
    val subtext: String?,
    val leaveLabel: String,
    val leaveExplainer: String,
    val emptyText: String?,
)

/** The model for [key], or null if that bubble is gone or that area is not on this map. */
fun conversationScreen(key: ConversationKey, s: SessionState): ConversationScreenModel? {
    val m = usersModel(s)
    val c: Conversation = (listOfNotNull(m.active) + m.bubbles + m.meetingAreas).firstOrNull { it.key == key }
        ?: (key as? ConversationKey.AreaKey)?.let { k ->
            m.otherAreas.firstOrNull { (it.area.id ?: it.area.name) == k.key }?.let { e ->
                Conversation(key, e.area.name, e.occupants, joined = s.inAreas.any { (it.id ?: it.name) == k.key })
            }
        }
        ?: return null
    val isBubble = key is ConversationKey.Bubble
    val noun = if (isBubble) "bubble" else "area"
    val the = if (isBubble) "the bubble" else c.title
    val area = (key as? ConversationKey.AreaKey)?.let { k -> s.areas.firstOrNull { (it.id ?: it.name) == k.key } }
    val jitsi = area?.isJitsi() == true
    val others = c.members.filter { !it.isMe }
    val walking = when (val a = s.activity) {
        is Activity.WalkingTo -> if (isBubble) others.any { it.name.ifBlank { "Unnamed player" } == a.label } else a.label == c.title
        else -> false
    }
    val leaving = s.activity is Activity.WalkingOut && c.joined
    val phase = when {
        jitsi -> Phase.Jitsi
        leaving -> Phase.Leaving
        c.joined -> Phase.Joined
        walking -> Phase.Walking
        else -> Phase.CanJoin
    }
    return ConversationScreenModel(
        title = c.title, noun = noun, members = c.members, phase = phase,
        strip = if (c.joined) "You are in this $noun" else "You are not in this $noun",
        joinLabel = if (jitsi) "Join in Jitsi" else "Join the $noun",
        explainer = when {
            jitsi -> JITSI_NOT_SUPPORTED_MESSAGE
            isBubble -> "Walk your avatar over to talk to them"
            else -> "Walk your avatar into the area to talk to them"
        },
        subtext = if (c.joined) { if (others.isEmpty()) "Waiting in $the" else "Talking in $the" } else null,
        leaveLabel = "Leave the $noun",
        leaveExplainer = "Walk your avatar out of the $noun",
        emptyText = if (c.members.isEmpty()) "Nobody is here yet" else null,
    )
}
