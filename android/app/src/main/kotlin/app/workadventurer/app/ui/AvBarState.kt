package app.workadventurer.app.ui

/** What the persistent bottom bar (mic, camera, more) shows and says. Pure so the wording is tested; drawing lives in AvBar. */
data class AvBarState(
    val micMuted: Boolean,
    val micDescription: String,
    val cameraDescription: String,
    val cameraMessage: String,
)

fun avBarState(muted: Boolean) = AvBarState(
    micMuted = muted,
    micDescription = if (muted) "Unmute the microphone" else "Mute the microphone",
    cameraDescription = "Camera not supported yet",
    cameraMessage = "Camera not (yet) supported",
)

const val AUDIO_SHEET_TITLE = "Audio"
