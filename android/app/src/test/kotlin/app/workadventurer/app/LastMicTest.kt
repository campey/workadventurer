package app.workadventurer.app

import kotlin.test.Test
import kotlin.test.assertEquals

class LastMicTest {
    private class MemoryStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String) { values[key] = value }
    }

    // A fresh install must never go live by accident.
    @Test
    fun aFreshInstallIsMuted() {
        assertEquals(false, LastMic(MemoryStore()).isOn())
    }

    @Test
    fun theChoiceComesBackNextTime() {
        val store = MemoryStore()
        LastMic(store).remember(true)
        assertEquals(true, LastMic(store).isOn()) // a new instance, as after an app restart
        LastMic(store).remember(false)
        assertEquals(false, LastMic(store).isOn())
    }

    @Test
    fun anythingUnexpectedInTheStoreMeansMuted() {
        val store = MemoryStore()
        store.put("last_mic_on", "yes please")
        assertEquals(false, LastMic(store).isOn())
    }
}
