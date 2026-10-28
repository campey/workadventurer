package app.workadventurer.app.ui

import app.workadventurer.protocol.Area

/** What the app says about a Jitsi area: it can't be in one yet (issue #119 is the hand-over to the Jitsi app). */
const val JITSI_NOT_SUPPORTED_MESSAGE = "Jitsi meetings not (yet) supported (#119)"

/** A Jitsi area: people in it are in a Jitsi call, not a proximity bubble or LiveKit room. An area that is also a LiveKit room counts as that. */
fun Area.isJitsi() = meetingRoom == null && "jitsiRoomProperty" in propertyTypes

/** The Jitsi area [now] contains that [before] did not (we just walked in), or null. The warning is for the moment of entering. */
fun jitsiEntered(before: List<Area>, now: List<Area>): Area? {
    val had = before.map { it.id ?: it.name }.toSet()
    return now.firstOrNull { it.isJitsi() && (it.id ?: it.name) !in had }
}
