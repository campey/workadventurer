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
        val settings = AdapterUpdatesSetting(Mem())
        var seenMode: AdapterUpdates? = null
        var seenThread = ""
        val callerThread = Thread.currentThread().name
        val r = CatalogAdapterRecovery(settings, store, OkHttpClient()) { _, mode, ask, onAlways ->
            seenMode = mode
            seenThread = Thread.currentThread().name
            if (ask(AdapterOffer("deadbeef", null)) == AdapterAnswer.ALWAYS) onAlways()
            RecoverOutcome.Declined("deadbeef")
        }
        r.recover("https://x/") { AdapterAnswer.ALWAYS }
        assertEquals(AdapterUpdates.AUTO, settings.flow.value) // the Settings sheet follows this
        assertEquals(AdapterUpdates.ASK, seenMode)
        assertEquals(AdapterUpdates.AUTO, settings.updates)
        assertNotEquals(callerThread, seenThread, "recovery must not run on the caller's thread")
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
