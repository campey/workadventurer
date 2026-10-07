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
