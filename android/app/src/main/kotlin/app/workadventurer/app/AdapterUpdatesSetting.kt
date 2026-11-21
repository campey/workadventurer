package app.workadventurer.app

import app.workadventurer.app.session.AdapterSettings
import app.workadventurer.protocol.catalog.AdapterUpdates

/**
 * "Adapter updates" (#126): `ask` (default), `auto` or `never`. Anything stored that isn't exactly `auto` or `never` means `ask`,
 * so a garbled value can never switch downloads on.
 */
class AdapterUpdatesSetting(private val store: KeyValueStore) : AdapterSettings {
    override var updates: AdapterUpdates
        get() = when (store.get(KEY)) {
            "auto" -> AdapterUpdates.AUTO
            "never" -> AdapterUpdates.NEVER
            else -> AdapterUpdates.ASK
        }
        set(v) = store.put(KEY, v.name.lowercase())

    private companion object { const val KEY = "adapter_updates" }
}
