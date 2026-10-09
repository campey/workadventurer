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
