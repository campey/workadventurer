package app.workadventurer.app.ui

import app.workadventurer.app.session.Activity
import app.workadventurer.app.session.SessionState

/** Where the conversation screen's action is: join, on the way, in it, on the way out, a Jitsi area we cannot join, a locked bubble, or a silent area (nobody can talk in either). */
enum class Phase { CanJoin, Walking, Joined, Leaving, Jitsi, Locked, Silent, Unavailable, Megaphone }

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
    val emptyText: String?,
    /** For a bubble: who to walk over to (someone still here), or null. */
    val walkTargetId: Int? = null,
)

/** The model for [key], or null if that bubble is gone or that area is not on this map. */
fun conversationScreen(key: ConversationKey, s: SessionState, left: Set<Int> = emptySet()): ConversationScreenModel? {
    val m = usersModel(s, left = left)
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
    val silentArea = area?.isSilent() == true && !jitsi
    val megaphone = area?.isMegaphone() == true && !jitsi
    val myBlock = yourStatusReason(s.myStatus) // your own do not disturb / back in a moment comes first: nothing else would work
    val others = c.members.filter { !it.isMe && it.leaving == null } // someone who just left is still listed, but is not company
    val walking = when (val a = s.activity) {
        is Activity.WalkingTo -> if (isBubble) others.any { it.name.ifBlank { "Unnamed player" } == a.label } else a.label == c.title
        else -> false
    }
    val leaving = s.activity is Activity.WalkingOut && c.joined
    val phase = when {
        jitsi -> Phase.Jitsi
        leaving -> Phase.Leaving
        c.joined -> Phase.Joined
        myBlock != null -> Phase.Unavailable
        megaphone -> Phase.Megaphone
        c.locked -> Phase.Locked
        silentArea -> Phase.Silent
        walking -> Phase.Walking
        else -> Phase.CanJoin
    }
    return ConversationScreenModel(
        title = c.title, noun = noun, members = c.members, phase = phase,
        strip = if (c.joined) "You are in this $noun" else "You are not in this $noun",
        joinLabel = if (jitsi) "Join in Jitsi" else if (c.locked) "This bubble is locked" else if (silentArea) "This area is silent" else if (megaphone) "This is a megaphone zone" else "Join the $noun",
        explainer = when {
            jitsi -> JITSI_NOT_SUPPORTED_MESSAGE
            myBlock != null -> myBlock
            c.locked -> "The people in it have locked it, so nobody else can join"
            silentArea -> "Conversations don't work in a silent area"
            megaphone -> if ("speakerMegaphone" in area!!.propertyTypes) "Whoever stands here speaks to everyone in the listener areas. The app can't use a megaphone yet"
                else "Whoever stands here hears the speaker. The app can't listen to a megaphone yet"
            isBubble -> "Walk your avatar over to talk to them"
            else -> "Walk your avatar into the area to talk to them"
        },
        subtext = if (c.joined) {
            when {
                // A meeting on the server's LiveKit room has no audio until the app is in it (#134): don't claim we are talking.
                s.audio == app.workadventurer.voice.AudioStatus.Connecting -> "Connecting audio in $the…"
                s.audio == app.workadventurer.voice.AudioStatus.Failed -> "Can't connect audio in $the"
                others.isEmpty() -> "Waiting in $the"
                else -> "Talking in $the"
            }
        } else null,
        leaveLabel = "Leave the $noun",
        emptyText = if (c.members.isEmpty()) "Nobody is here yet" else null,
        walkTargetId = others.firstOrNull()?.userId,
    )
}

/**
 * The screen of a bubble the server has just dissolved (it drops a bubble of fewer than two people), kept for a moment with the
 * others dimmed, so the screen doesn't vanish under you (#134). Nothing on it can be acted on.
 */
fun dissolvedBubble(last: ConversationScreenModel): ConversationScreenModel = last.copy(
    members = last.members.map { if (it.isMe) it else it.copy(leaving = "Left the bubble…") },
    phase = Phase.Unavailable, joinLabel = "This bubble has ended", explainer = "Everyone has left it", subtext = null,
    walkTargetId = null,
)

/** Whether a dissolved bubble's screen stays up for a moment: not when you walked out of it yourself (you know it ended). */
fun holdsWhenDissolved(last: ConversationScreenModel): Boolean = last.phase != Phase.Leaving
