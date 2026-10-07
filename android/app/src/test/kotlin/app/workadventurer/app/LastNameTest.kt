package app.workadventurer.app

import kotlin.test.Test
import kotlin.test.assertEquals

class LastNameTest {
    private class MemoryStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String) { values[key] = value }
    }

    @Test
    fun aFreshInstallHasNoNameYet() {
        assertEquals("", LastName(MemoryStore()).get())
    }

    @Test
    fun theNameYouJoinedWithComesBackNextTime() {
        val store = MemoryStore()
        LastName(store).remember("Ada")
        assertEquals("Ada", LastName(store).get()) // a new instance, as after an app restart
    }

    @Test
    fun theMostRecentNameWinsAndSurroundingSpacesAreDropped() {
        val store = MemoryStore()
        LastName(store).remember("  Ada ")
        LastName(store).remember("Bo")
        assertEquals("Bo", LastName(store).get())
    }

    // A blank name can't be joined with anyway; it must never wipe a good remembered one.
    @Test
    fun aBlankNameDoesNotOverwriteTheRememberedOne() {
        val store = MemoryStore()
        LastName(store).remember("Ada")
        LastName(store).remember("   ")
        assertEquals("Ada", LastName(store).get())
    }
}
