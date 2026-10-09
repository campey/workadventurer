package app.workadventurer.app.ui

/** What the persistent bottom bar (mic, camera, more) shows and says. Pure so the wording is tested; drawing lives in AvBar. */
data class AvBarState(
    val micMuted: Boolean,
    val micDescription: String,
    val cameraDescription: String,
    val cameraMessage: String,
    val moreDescription: String,
)

fun avBarState(muted: Boolean) = AvBarState(
    micMuted = muted,
    micDescription = if (muted) "Unmute the microphone" else "Mute the microphone",
    cameraDescription = "Camera not supported yet",
    cameraMessage = "Camera not (yet) supported",
    moreDescription = "More audio and video options",
)

const val AUDIO_VIDEO_SHEET_TITLE = "Audio and video"

/** The microphone line in the audio and video sheet: its state, and which microphone (only the built-in one for now). */
fun micSheetText(muted: Boolean) = "${if (muted) "Muted" else "On"} · Built-in microphone"
