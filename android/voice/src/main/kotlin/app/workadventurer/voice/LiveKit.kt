package app.workadventurer.voice

/** Where the audio of the meeting you are in stands, for the screen to say so: nothing special, joining the server's LiveKit room, in it, or it would not connect. */
enum class AudioStatus { None, Connecting, Connected, Failed }

/**
 * One connection to the LiveKit room the server moved a big meeting to (#134). [connect] returns once we are in the room (or throws);
 * the call hears everyone by itself, and sends our microphone only while unmuted. A new call starts muted.
 */
interface LiveKitCall {
    suspend fun connect(serverUrl: String, token: String)
    fun setMuted(muted: Boolean)
    fun close()
}

/** Makes the call for [spaceName]'s meeting. */
fun interface LiveKitFactory { fun create(spaceName: String): LiveKitCall }
