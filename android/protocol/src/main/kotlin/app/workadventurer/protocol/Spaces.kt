package app.workadventurer.protocol

/** The server answered a query with an error. */
class QueryFailed(message: String) : Exception(message)

/**
 * The server didn't answer in time. Deliberately NOT a CancellationException (which kotlinx's withTimeout throws): code that
 * rethrows cancellation, as it must, would otherwise let a slow server silently cancel its own caller.
 */
class QueryTimeout(message: String) : Exception(message)

/** What the wa-1.33/1.34 adapter asks to sync when the server doesn't say. */
val DEFAULT_SPACE_PROPS = listOf("cameraState", "microphoneState", "screenSharingState")

/** WebRTC signalling from other members of a space we are in, plus "we left the space". */
sealed interface VoiceEvent {
    val spaceName: String

    /** [initiator] true means we must send the offer; false means we answer. */
    data class Start(override val spaceName: String, val peerSpaceUserId: String, val connectionId: String, val initiator: Boolean) : VoiceEvent
    data class Signal(override val spaceName: String, val peerSpaceUserId: String, val connectionId: String, val signal: String) : VoiceEvent
    data class Disconnect(override val spaceName: String, val peerSpaceUserId: String) : VoiceEvent

    /** We left the space: every link in it must go. */
    data class SpaceLeft(override val spaceName: String) : VoiceEvent
}

data class IceServerInfo(val urls: List<String>, val username: String?, val credential: String?)

internal val FALLBACK_ICE = listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null))
