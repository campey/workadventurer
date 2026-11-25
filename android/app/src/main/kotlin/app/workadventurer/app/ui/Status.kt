package app.workadventurer.app.ui

import app.workadventurer.proto.AvailabilityStatus

/**
 * What a player's availability reads as, in the WorkAdventure web client's own words (play/src/i18n/en-US/chat.ts) so the app
 * and the web say the same thing. "Unchanged" is not a state: it marks a details update about something else, read as online.
 */
fun statusLabel(s: AvailabilityStatus): String = when (s) {
    AvailabilityStatus.ONLINE, AvailabilityStatus.UNCHANGED -> "Online"
    AvailabilityStatus.AWAY -> "Away"
    AvailabilityStatus.BUSY -> "Busy"
    AvailabilityStatus.DO_NOT_DISTURB -> "Do not disturb"
    AvailabilityStatus.BACK_IN_A_MOMENT -> "Back in a moment"
    AvailabilityStatus.SOUND_BLOCKED -> "Sound blocked"
    AvailabilityStatus.JITSI, AvailabilityStatus.BBB, AvailabilityStatus.LIVEKIT, AvailabilityStatus.LISTENER -> "In a meeting"
    AvailabilityStatus.SPEAKER -> "Using the megaphone"
    AvailabilityStatus.SILENT, AvailabilityStatus.DENY_PROXIMITY_MEETING -> "Unavailable"
}

/** The status dot's colour (ARGB), the web client's (play/src/front/Utils/AvailabilityStatus.ts). Always shown with its label. */
fun statusColor(s: AvailabilityStatus): Long = when (s) {
    AvailabilityStatus.ONLINE, AvailabilityStatus.UNCHANGED, AvailabilityStatus.JITSI, AvailabilityStatus.BBB,
    AvailabilityStatus.LIVEKIT, AvailabilityStatus.LISTENER -> 0xFF68E97AL
    AvailabilityStatus.AWAY, AvailabilityStatus.BUSY, AvailabilityStatus.SPEAKER -> 0xFFE9C84EL
    AvailabilityStatus.DO_NOT_DISTURB -> 0xFFE96E53L
    AvailabilityStatus.BACK_IN_A_MOMENT, AvailabilityStatus.SOUND_BLOCKED -> 0xFF7382E2L
    AvailabilityStatus.SILENT -> 0xFFE74C3CL
    AvailabilityStatus.DENY_PROXIMITY_MEETING -> 0xFFFFFFFFL
}

/**
 * Why someone can't be in a conversation right now, or null when they can. With these statuses the server never puts a person in a
 * bubble (and takes them out of the one they are in): back/src/Model/User.ts `silent`. Busy and away are only prompts on the web
 * client, and a meeting (LiveKit, Jitsi, BBB) is a place you walk into, so those say nothing here (#111).
 */
fun unavailableReason(s: AvailabilityStatus): String? {
    val why = when (s) {
        AvailabilityStatus.DO_NOT_DISTURB -> "They are on do not disturb"
        AvailabilityStatus.BACK_IN_A_MOMENT -> "They will be back in a moment"
        AvailabilityStatus.SOUND_BLOCKED -> "Their sound is blocked"
        AvailabilityStatus.SILENT -> "They are in a silent area"
        AvailabilityStatus.DENY_PROXIMITY_MEETING -> "They are not taking part in proximity meetings"
        AvailabilityStatus.SPEAKER -> "They are using the megaphone"
        AvailabilityStatus.LISTENER -> "They are listening to a megaphone"
        else -> return null
    }
    return "$why, so they can't be in a conversation right now"
}

/** A status you can pick for yourself, with what it means (#111). The web client's menu offers these four. */
data class StatusChoice(val status: AvailabilityStatus, val hint: String)

val SELECTABLE_STATUSES = listOf(
    StatusChoice(AvailabilityStatus.ONLINE, "Anyone can talk to you"),
    StatusChoice(AvailabilityStatus.BUSY, "Others see you are busy, but you can still talk"),
    StatusChoice(AvailabilityStatus.BACK_IN_A_MOMENT, "Nobody can join you, and you can't join anyone"),
    StatusChoice(AvailabilityStatus.DO_NOT_DISTURB, "Nobody can join you, and you can't join anyone"),
)

/** Why your own status stops you joining conversations (the server keeps these two out of every bubble), or null when it doesn't. */
fun yourStatusReason(s: AvailabilityStatus): String? = when (s) {
    AvailabilityStatus.DO_NOT_DISTURB -> "You are on do not disturb, so you can't join conversations"
    AvailabilityStatus.BACK_IN_A_MOMENT -> "You said you will be back in a moment, so you can't join conversations"
    else -> null
}

/** Not in a world: the protocol has no such status, but the web client says "Offline" and shows a grey dot. */
const val OFFLINE_LABEL = "Offline"
const val OFFLINE_COLOR = 0xFF6B7A90L
