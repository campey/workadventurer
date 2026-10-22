package app.workadventurer.app

/**
 * How many times you have been in each map area, per room (issue #159), so the Users screen can list the places you go
 * first. A room's counts are one small value in the key-value store: a line per area, `key<TAB>count`. An area key that
 * could not be stored on one line is not counted, and anything garbled in the store is ignored when read back.
 */
class AreaVisits(private val store: KeyValueStore) {
    fun counts(room: String): Map<String, Int> =
        store.get(key(room)).orEmpty().lineSequence().mapNotNull { line ->
            val parts = line.split('\t')
            val count = parts.getOrNull(1)?.toIntOrNull()
            if (parts.size == 2 && parts[0].isNotBlank() && count != null && count > 0) parts[0] to count else null
        }.toMap() // a repeated key keeps its last line

    fun record(room: String, areaKey: String) {
        if (areaKey.isBlank() || '\t' in areaKey || '\n' in areaKey || '\r' in areaKey) return
        val counts = counts(room).toMutableMap()
        counts[areaKey] = (counts[areaKey] ?: 0) + 1
        store.put(key(room), counts.entries.joinToString("\n") { "${it.key}\t${it.value}" })
    }

    private fun key(room: String) = "area_visits:${room.trim()}"
}

/** The areas in [now] that [before] did not have: walking into one. Standing in one, or leaving it, is not entering. */
fun areasEntered(before: Set<String>, now: Set<String>): Set<String> = now - before
