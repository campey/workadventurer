package app.workadventurer.app

import android.content.Context

/** The smallest key-value store the app needs, so the logic below tests without Android. */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
}

/** [KeyValueStore] over the app's private SharedPreferences. */
class PrefsStore(context: Context) : KeyValueStore {
    private val prefs = context.getSharedPreferences("workadventurer", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String) { prefs.edit().putString(key, value).apply() }
}

/**
 * Whether the microphone was on when you last used the app, so the next join starts the same way (issue #77). Defaults to muted,
 * and only the exact stored value "1" means on, so nothing odd in the store can put a fresh join live.
 */
class LastMic(private val store: KeyValueStore) {
    fun isOn(): Boolean = store.get(KEY) == "1"
    fun remember(on: Boolean) { store.put(KEY, if (on) "1" else "0") }

    private companion object { const val KEY = "last_mic_on" }
}

/** The name last joined with, so the join screen starts with it filled in. Room history is the fuller version (issue #93). */
class LastName(private val store: KeyValueStore) {
    fun get(): String = store.get(KEY).orEmpty()

    /** Blank names are ignored: they can't be joined with, and must not wipe a good one. */
    fun remember(name: String) {
        val n = name.trim()
        if (n.isNotEmpty()) store.put(KEY, n)
    }

    private companion object { const val KEY = "last_name" }
}
