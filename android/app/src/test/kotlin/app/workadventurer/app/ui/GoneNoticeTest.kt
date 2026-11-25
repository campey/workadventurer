package app.workadventurer.app.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class GoneNoticeTest {
    // A person's screen that is open when they leave the room still says who it was, and what happened.
    @Test
    fun aPersonWhoLeftIsNamed() {
        assertEquals("android-lk-1 has left the room", personGoneNotice("android-lk-1"))
    }

    @Test
    fun anUnknownPersonStillSaysTheyLeft() {
        assertEquals("This person has left the room", personGoneNotice(null))
        assertEquals("This person has left the room", personGoneNotice("  "))
    }

    // A bubble dissolves when everyone in it has gone: say that, not that "the conversation is no longer here".
    @Test
    fun aBubbleThatEndedSaysSo() {
        assertEquals("This bubble has ended: everyone has left it", conversationGoneNotice())
    }
}
