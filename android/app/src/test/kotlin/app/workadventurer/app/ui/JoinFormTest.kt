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
    fun theNewWorldEntryHasItsOwnLabel() {
        assertEquals("+ New world", NEW_WORLD_LABEL)
    }
}
