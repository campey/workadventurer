package app.workadventurer.app

import kotlin.test.Test
import kotlin.test.assertEquals

class AreaVisitsTest {
    private class MemoryStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String) { values[key] = value }
    }

    private val room = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space"

    @Test
    fun aFreshInstallHasNoVisits() {
        assertEquals(emptyMap(), AreaVisits(MemoryStore()).counts(room))
    }

    @Test
    fun eachVisitCountsAndSurvivesARestart() {
        val store = MemoryStore()
        AreaVisits(store).record(room, "fire")
        AreaVisits(store).record(room, "fire")
        AreaVisits(store).record(room, "red")
        assertEquals(mapOf("fire" to 2, "red" to 1), AreaVisits(store).counts(room)) // new instances, as after restarts
    }

    @Test
    fun roomsKeepTheirOwnCounts() {
        val v = AreaVisits(MemoryStore())
        v.record(room, "fire")
        v.record("https://play.staging.workadventu.re/@/tcm/workadventure/wa-village", "fire")
        v.record("https://play.staging.workadventu.re/@/tcm/workadventure/wa-village", "fire")
        assertEquals(mapOf("fire" to 1), v.counts(room))
    }

    @Test
    fun anAreaNameWithOddCharactersAndGarbageInTheStoreAreHandled() {
        val store = MemoryStore()
        val v = AreaVisits(store)
        v.record(room, "Tab\there\nnewline")
        v.record(room, "ok")
        assertEquals(mapOf("ok" to 1), v.counts(room)) // a key that can't be stored safely is not stored
        store.values.keys.forEach { store.values[it] = "ok\t3\nnonsense\nbad\tnotanumber\nneg\t-4\nok\t2" }
        assertEquals(mapOf("ok" to 2), AreaVisits(store).counts(room)) // garbled lines are ignored, the last good one wins
    }

    @Test
    fun walkingIntoAnAreaIsTheOnlyWayToEnterIt() {
        assertEquals(listOf("b"), areasEntered(before = setOf("a"), now = setOf("a", "b")).toList())
        assertEquals(emptyList(), areasEntered(before = setOf("a"), now = setOf("a")).toList()) // still in it
        assertEquals(emptyList(), areasEntered(before = setOf("a"), now = emptySet()).toList()) // leaving
        assertEquals(listOf("a"), areasEntered(before = emptySet(), now = setOf("a")).toList())
    }
}
