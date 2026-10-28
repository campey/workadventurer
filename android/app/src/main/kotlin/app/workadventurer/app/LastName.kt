package app.workadventurer.app

import android.content.Context
import app.workadventurer.protocol.Texture
import app.workadventurer.protocol.WaStaging

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

/**
 * The layers of your own woka picture as the server last told us, per server (prod or staging; rooms on one server share it), so
 * the Join screen can show how you will look before connecting: the picture's address only comes back once you are in. Empty means
 * unknown. Only plain https layers are read back (they are fetched later), at most [MAX_LAYERS], and anything garbled is ignored.
 */
class LastTextures(private val store: KeyValueStore) {
    fun get(roomUrl: String): List<Texture> =
        store.get(key(roomUrl)).orEmpty().lineSequence().mapNotNull { line ->
            val parts = line.split('\t')
            if (parts.size == 2 && parts[0].isNotBlank() && parts[1].startsWith("https://")) Texture(parts[0], parts[1]) else null
        }.take(MAX_LAYERS).toList()

    /** An empty list means we were told nothing: it never wipes a remembered picture. */
    fun remember(roomUrl: String, textures: List<Texture>) {
        val clean = textures.filter { it.id.isNotBlank() && '\t' !in it.id && '\n' !in it.id && '\t' !in it.url && '\n' !in it.url }.take(MAX_LAYERS)
        if (clean.isNotEmpty()) store.put(key(roomUrl), clean.joinToString("\n") { "${it.id}\t${it.url}" })
    }

    private fun key(roomUrl: String): String {
        val host = runCatching { java.net.URI(roomUrl.trim()).host }.getOrNull()
        return "last_textures_${if (host == WaStaging.HOST) "staging" else "prod"}"
    }

    private companion object { const val MAX_LAYERS = 12 }
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
