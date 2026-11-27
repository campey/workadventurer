package app.workadventurer.app

import app.workadventurer.app.session.AdapterSettings
import app.workadventurer.app.session.CatalogAdapterRecovery
import app.workadventurer.protocol.catalog.AdapterAnswer
import app.workadventurer.protocol.catalog.AdapterOffer
import app.workadventurer.protocol.catalog.AdapterStore
import app.workadventurer.protocol.catalog.AdapterUpdates
import app.workadventurer.protocol.catalog.RecoverOutcome
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class CatalogAdapterRecoveryTest {
    private class Mem : KeyValueStore {
        val m = mutableMapOf<String, String>()
        override fun get(key: String) = m[key]
        override fun put(key: String, value: String) { m[key] = value }
    }

    private val store = object : AdapterStore {
        override fun load(hash: String) = null
        override fun save(hash: String, text: String) {}
        override fun delete(hash: String) {}
    }

    @Test
    fun settingDefaultsToAskAndIgnoresGarbage() {
        val kv = Mem()
        val s = AdapterUpdatesSetting(kv)
        assertEquals(AdapterUpdates.ASK, s.updates)
        kv.put("adapter_updates", "AUTO "); assertEquals(AdapterUpdates.ASK, s.updates)
        s.updates = AdapterUpdates.AUTO; assertEquals(AdapterUpdates.AUTO, s.updates)
        s.updates = AdapterUpdates.NEVER; assertEquals(AdapterUpdates.NEVER, s.updates)
        assertEquals(AdapterUpdates.NEVER, s.flow.value)
        assertEquals(AdapterUpdates.NEVER, AdapterUpdatesSetting(kv).updates) // persisted
    }

    @Test
    fun alwaysAnswerPersistsAutoAndModeIsReadAtCallTime() = runBlocking {
        val inner = AdapterUpdatesSetting(Mem())
        var readThread = ""
        val settings = object : AdapterSettings {
            override var updates: AdapterUpdates
                get() { readThread = Thread.currentThread().name; return inner.updates }
                set(v) { inner.updates = v }
        }
        var seenMode: AdapterUpdates? = null
        var askThread = ""
        val callerThread = Thread.currentThread().name
        val r = CatalogAdapterRecovery(settings, store, OkHttpClient()) { _, mode, ask, onAlways ->
            seenMode = mode
            if (ask(AdapterOffer("deadbeef", null)) == AdapterAnswer.ALWAYS) onAlways()
            RecoverOutcome.Declined("deadbeef")
        }
        r.recover("https://x/") { askThread = Thread.currentThread().name; AdapterAnswer.ALWAYS }
        assertEquals(AdapterUpdates.AUTO, inner.flow.value) // the Settings sheet follows this
        assertEquals(AdapterUpdates.ASK, seenMode)
        assertEquals(AdapterUpdates.AUTO, inner.updates)
        assertEquals(callerThread, askThread, "ask (it shows UI) stays on the caller's dispatcher")
        assertNotEquals(callerThread, readThread, "the preference read (disk) is off the caller's thread")
        r.recover("https://x/") { AdapterAnswer.NO }
        assertEquals(AdapterUpdates.AUTO, seenMode)
    }

    @Test
    fun forgetDeletesTheCachedFileOffTheCallersThread() = runBlocking {
        val deleted = mutableListOf<Pair<String, String>>()
        val st = object : AdapterStore {
            override fun load(hash: String) = null
            override fun save(hash: String, text: String) {}
            override fun delete(hash: String) { deleted += hash to Thread.currentThread().name }
        }
        val r = CatalogAdapterRecovery(AdapterUpdatesSetting(Mem()), st, OkHttpClient()) { _, _, _, _ -> RecoverOutcome.Declined("deadbeef") }
        r.forget("deadbeef")
        assertEquals(listOf("deadbeef"), deleted.map { it.first })
        assertNotEquals(Thread.currentThread().name, deleted.single().second)
    }

    @Test
    fun yesAndNoDoNotChangeThePreference() = runBlocking {
        val settings = AdapterUpdatesSetting(Mem())
        val r = CatalogAdapterRecovery(settings, store, OkHttpClient()) { _, _, ask, onAlways ->
            if (ask(AdapterOffer("deadbeef", null)) == AdapterAnswer.ALWAYS) onAlways()
            RecoverOutcome.Declined("deadbeef")
        }
        r.recover("https://x/") { AdapterAnswer.YES }
        r.recover("https://x/") { AdapterAnswer.NO }
        assertEquals(AdapterUpdates.ASK, settings.updates)
    }
}
