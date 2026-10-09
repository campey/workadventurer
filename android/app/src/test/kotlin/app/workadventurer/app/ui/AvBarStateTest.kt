package app.workadventurer.app.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class AvBarStateTest {
    // Every control says its whole action, not just its icon, for TalkBack.
    @Test
    fun theMicButtonSaysWhatTappingItWillDo() {
        assertEquals("Unmute the microphone", avBarState(muted = true).micDescription)
        assertEquals("Mute the microphone", avBarState(muted = false).micDescription)
    }

    @Test
    fun theMicIconShowsTheCurrentState() {
        assertEquals(true, avBarState(muted = true).micMuted)
        assertEquals(false, avBarState(muted = false).micMuted)
    }

    // Video isn't supported yet: the button is there, disabled, and says why instead of doing nothing.
    @Test
    fun theCameraIsAlwaysOffAndExplainsWhy() {
        for (muted in listOf(true, false)) {
            val s = avBarState(muted)
            assertEquals("Camera not supported yet", s.cameraDescription)
            assertEquals("Camera not (yet) supported", s.cameraMessage)
        }
    }

    @Test
    fun theOverflowButtonOpensTheAudioAndVideoSheet() {
        assertEquals("More audio and video options", avBarState(true).moreDescription)
        assertEquals("Audio and video", AUDIO_VIDEO_SHEET_TITLE)
    }

    @Test
    fun theSheetDescribesTheMicrophone() {
        assertEquals("Muted · Built-in microphone", micSheetText(muted = true))
        assertEquals("On · Built-in microphone", micSheetText(muted = false))
    }
}
