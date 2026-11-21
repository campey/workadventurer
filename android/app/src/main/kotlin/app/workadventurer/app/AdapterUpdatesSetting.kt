package app.workadventurer.app

import app.workadventurer.app.session.AdapterSettings
import app.workadventurer.protocol.catalog.AdapterUpdates
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * "Adapter updates" (#126): `ask` (default), `auto` or `never`. Anything stored that isn't exactly `auto` or `never` means `ask`,
 * so a garbled value can never switch downloads on. [flow] is the live value (the Settings sheet follows it, so "Don't ask again"
 * shows up there); use one instance per process.
 */
class AdapterUpdatesSetting(private val store: KeyValueStore) : AdapterSettings {
    private val _flow = MutableStateFlow(read())
    val flow: StateFlow<AdapterUpdates> = _flow

    private fun read() = when (store.get(KEY)) {
        "auto" -> AdapterUpdates.AUTO
        "never" -> AdapterUpdates.NEVER
        else -> AdapterUpdates.ASK
    }

    override var updates: AdapterUpdates
        get() = _flow.value
        set(v) { store.put(KEY, v.name.lowercase()); _flow.value = v }

    private companion object { const val KEY = "adapter_updates" }
}
