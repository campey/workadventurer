package app.workadventurer.app

import app.workadventurer.protocol.Texture
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChosenWokaTest {
    private class MemoryStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String) { values[key] = value }
    }

    private val prod = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space"
    private val staging = "https://play.staging.workadventu.re/@/tcm/workadventure/wa-village"
    private val bob = Texture("506a3a64", "https://admin.workadventu.re/wokas/Character_full/Full1.png")

    @Test
    fun nothingIsChosenUntilYouChoose() {
        assertNull(ChosenWoka(MemoryStore()).get(prod))
    }

    @Test
    fun theChoiceComesBackNextTime() {
        val store = MemoryStore()
        ChosenWoka(store).choose(prod, bob)
        assertEquals(bob, ChosenWoka(store).get(prod)) // a new instance, as after an app restart
    }

    // The catalogue is the server's, so each server keeps its own choice; rooms on one server share it.
    @Test
    fun eachServerKeepsItsOwnChoice() {
        val store = MemoryStore()
        ChosenWoka(store).choose(prod, bob)
        assertNull(ChosenWoka(store).get(staging))
        assertEquals(bob, ChosenWoka(store).get("https://play.workadventu.re/@/other/world/room"))
    }

    @Test
    fun forgettingGoesBackToTheDefault() {
        val store = MemoryStore()
        ChosenWoka(store).choose(prod, bob)
        ChosenWoka(store).forget(prod)
        assertNull(ChosenWoka(store).get(prod))
    }

    // Only a plain https picture is read back, as with the remembered layers: it is fetched later.
    @Test
    fun garbledOrUnsafeEntriesAreIgnored() {
        val store = MemoryStore()
        store.put("chosen_woka_prod", "no tab here")
        assertNull(ChosenWoka(store).get(prod))
        store.put("chosen_woka_prod", "id\thttp://insecure/x.png")
        assertNull(ChosenWoka(store).get(prod))
        store.put("chosen_woka_prod", "\thttps://x/y.png")
        assertNull(ChosenWoka(store).get(prod))
    }

    @Test
    fun anIdOrAddressWithATabOrNewlineIsNotStored() {
        val store = MemoryStore()
        ChosenWoka(store).choose(prod, Texture("a\tb", "https://x/y.png"))
        ChosenWoka(store).choose(prod, Texture("ab", "https://x/y\n.png"))
        assertNull(ChosenWoka(store).get(prod))
    }

    // The server refuses a join with a woka it doesn't offer (a catalogue that changed): that must drop the choice, not keep failing.
    @Test
    fun onlyAnInvalidTextureRefusalMeansTheChoiceIsBad() {
        assertTrue(wokaWasRefused("invalid character texture"))
        assertTrue(wokaWasRefused("closed before join: 1000 invalid character texture"))
        assertFalse(wokaWasRefused("timed out waiting for roomJoinedMessage"))
        assertFalse(wokaWasRefused(""))
    }
}
