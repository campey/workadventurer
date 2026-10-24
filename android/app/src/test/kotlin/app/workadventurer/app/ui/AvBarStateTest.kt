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

    // The sheet is audio only (video gets its own, from the camera button, later); muting is the bar's mic, not a row in it.
    @Test
    fun theOverflowButtonOpensTheAudioSheet() {
        assertEquals("More audio options", avBarState(true).moreDescription)
        assertEquals("Audio", AUDIO_SHEET_TITLE)
    }
}
