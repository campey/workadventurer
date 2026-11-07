package app.workadventurer.app.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class JoinFormTest {
    @Test
    fun joiningNeedsANameAndAWorldAndNothingInProgress() {
        assertEquals(true, canJoin("Ada", "https://play.workadventu.re/@/a/b/c", joining = false))
        assertEquals(false, canJoin("", "https://play.workadventu.re/@/a/b/c", joining = false))
        assertEquals(false, canJoin("   ", "https://play.workadventu.re/@/a/b/c", joining = false))
        assertEquals(false, canJoin("Ada", "", joining = false)) // "+ New world" leaves the address empty until one is typed
        assertEquals(false, canJoin("Ada", "   ", joining = false))
        assertEquals(false, canJoin("Ada", "https://play.workadventu.re/@/a/b/c", joining = true))
    }

    @Test
    fun theExplainerSaysWhatIsMissingElseWhatJoinWillDo() {
        assertEquals("Enter your name to join", joinExplainer("", "https://play.workadventu.re/@/a/b/c"))
        assertEquals("Enter the world's address to join", joinExplainer("Ada", ""))
        assertEquals("Enter this world as Ada", joinExplainer("  Ada ", "https://play.workadventu.re/@/a/b/c"))
    }

    @Test
    fun theWokaPreviewShowsAnEllipsisUntilThePictureIsKnown() {
        assertEquals("…", WOKA_PREVIEW_PLACEHOLDER)
    }

    // The tile beside the name opens the picker, and says so to a screen reader (#108).
    @Test
    fun theWokaTileOpensThePicker() {
        assertEquals("Your woka, Offline. Opens the woka picker", wokaTileDescription(offline = true))
        assertEquals("Your woka, Online. Opens the woka picker", wokaTileDescription(offline = false))
    }

    @Test
    fun theNewWorldEntryHasItsOwnLabel() {
        assertEquals("+ New world", NEW_WORLD_LABEL)
    }

    // The world panel's "You" section: the name and woka are fixed for a connection, so changing either means rejoining.
    @Test
    fun rejoiningIsOfferedOnlyOnceTheNameOrWokaHasChanged() {
        assertEquals(false, canRejoin(current = "Ada", typed = "Ada", wokaChanged = false, connected = true)) // nothing to apply
        assertEquals(false, canRejoin(current = "Ada", typed = " Ada ", wokaChanged = false, connected = true)) // spaces are not a change
        assertEquals(true, canRejoin(current = "Ada", typed = "Bo", wokaChanged = false, connected = true))
        assertEquals(true, canRejoin(current = "Ada", typed = "Ada", wokaChanged = true, connected = true))
    }

    @Test
    fun rejoiningNeedsANameAndAConnectionToRejoinFrom() {
        assertEquals(false, canRejoin(current = "Ada", typed = "", wokaChanged = true, connected = true))
        assertEquals(false, canRejoin(current = "Ada", typed = "   ", wokaChanged = false, connected = true))
        assertEquals(false, canRejoin(current = "Ada", typed = "Bo", wokaChanged = false, connected = false)) // mid-reconnect
    }

    @Test
    fun theRejoinButtonAndItsLineSaySoPlainly() {
        assertEquals("Rejoin as Bo", rejoinLabel("  Bo "))
        assertEquals("Rejoin as you", rejoinLabel(""))
        assertEquals("Leaves and joins again with your new name or woka", REJOIN_EXPLAINER)
    }
}
