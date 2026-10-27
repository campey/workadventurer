package app.workadventurer.app.net

import app.workadventurer.app.KeyValueStore

/** Bytes per second between successive readings of a running byte counter. */
class RateMeter {
    private var lastBytes = -1L
    private var lastAtMs = 0L
    private var rate = 0.0

    /** The first reading has nothing to compare with (0); a counter that goes backwards starts over (0); two readings at one instant keep the last rate. */
    fun sample(bytes: Long, atMs: Long): Double {
        if (lastBytes < 0 || bytes < lastBytes) { rate = 0.0 }
        else if (atMs > lastAtMs) { rate = (bytes - lastBytes) * 1000.0 / (atMs - lastAtMs) }
        if (lastBytes < 0 || bytes < lastBytes || atMs > lastAtMs) { lastBytes = bytes; lastAtMs = atMs }
        return rate
    }
}

data class Totals(val up: Long, val down: Long)

/**
 * How much the app has sent and received: this session (since the last join) and all time (kept in the store, until reset). It is fed
 * the device's running counters for this app (`TrafficStats`), which count everything, not only calls. A counter that is unsupported
 * (-1) or has gone backwards (the device restarted) adds nothing for that reading and is simply taken as the new starting point.
 */
class UsageTotals(private val store: KeyValueStore) {
    private var lastUp = -1L
    private var lastDown = -1L
    var session = Totals(0, 0)
        private set
    var allTime = Totals(stored(KEY_UP), stored(KEY_DOWN))
        private set

    fun startSession(up: Long, down: Long) {
        session = Totals(0, 0)
        lastUp = up
        lastDown = down
    }

    fun update(up: Long, down: Long) {
        val dUp = delta(lastUp, up)
        val dDown = delta(lastDown, down)
        lastUp = up
        lastDown = down
        if (dUp == 0L && dDown == 0L) return
        session = Totals(session.up + dUp, session.down + dDown)
        allTime = Totals(allTime.up + dUp, allTime.down + dDown)
        store.put(KEY_UP, allTime.up.toString())
        store.put(KEY_DOWN, allTime.down.toString())
    }

    fun resetAllTime() {
        allTime = Totals(0, 0)
        store.put(KEY_UP, "0")
        store.put(KEY_DOWN, "0")
    }

    private fun delta(before: Long, now: Long) = if (before < 0 || now < before) 0L else now - before

    private fun stored(key: String) = store.get(key)?.toLongOrNull()?.takeIf { it >= 0 } ?: 0L

    private companion object { const val KEY_UP = "net_all_up"; const val KEY_DOWN = "net_all_down" }
}
