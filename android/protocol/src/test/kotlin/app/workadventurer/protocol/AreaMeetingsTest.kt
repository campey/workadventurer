package app.workadventurer.protocol

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private const val AFRO = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space"
private const val CAMPUS = "https://play.workadventu.re/@/levelup-npc/lean-iterator/campus"

@OptIn(ExperimentalCoroutinesApi::class)
class AreaMeetingsTest {
    // Expected values come from the Node adapter (src/adapters/wa-helpers.mjs shortHash/slugify): the server only recognises
    // the space if our name is byte-for-byte the one the web client computes.
    @Test
    fun theSpaceNameMatchesTheNodeAdapterForTheSameInputs() {
        assertEquals("9ida9r-fire-pit", areaMeetingSpaceName(AFRO, MeetingRoom("x1", "Fire pit")))
        assertEquals("9ida9r-abc-123", areaMeetingSpaceName(AFRO, MeetingRoom("AbC 123", "  ")))          // blank room name: the id
        assertEquals("9ida9r-p-7", areaMeetingSpaceName(AFRO, MeetingRoom("p-7", null)))
        assertEquals("9ida9r-cafe-zone-nandu", areaMeetingSpaceName(AFRO, MeetingRoom("x", "Café Zone: ñandú!"))) // accents, punctuation
        assertEquals("7e67gt-lean-coffee-table-1", areaMeetingSpaceName(CAMPUS, MeetingRoom("y", "Lean Coffee Table 1")))
        assertEquals("7e67gt-carte-blanche", areaMeetingSpaceName(CAMPUS, MeetingRoom("z", "Carte Blanche")))
        assertEquals("0-a", areaMeetingSpaceName("", MeetingRoom("b", "a")))
    }

    @Test
    fun anAreaCarriesItsMeetingRoomPropertyAndOthersDoNot() {
        val wam = """{"areas":[
            {"id":"a1","name":"Fire pit","x":0,"y":0,"width":64,"height":64,"properties":[{"id":"p1","type":"livekitRoomProperty","roomName":"Fire pit"}]},
            {"id":"a2","name":"Lounge","x":0,"y":0,"width":64,"height":64,"properties":[{"id":"p2","type":"livekitRoomProperty"}]},
            {"id":"a3","name":"Plain","x":0,"y":0,"width":64,"height":64,"properties":[{"type":"silent"}]}]}"""
        val areas = parseWam(wam)
        assertEquals(MeetingRoom("p1", "Fire pit"), areas[0].meetingRoom)
        assertEquals(MeetingRoom("p2", null), areas[1].meetingRoom)
        assertNull(areas[2].meetingRoom)
    }

    private class Rig(scope: kotlinx.coroutines.CoroutineScope, dwell: Long = 1_500, linger: Long = 2_500) {
        val log = mutableListOf<String>()
        val tracker = MeetingAreaTracker(scope, dwell, linger, { log += "join $it" }, { log += "leave $it" })
    }

    // Walking THROUGH an area (common on area-dense maps) must not spin a WebRTC peer up and straight back down.
    @Test
    fun joinsOnlyAfterTheDwellTime() = runTest {
        val r = Rig(backgroundScope)
        r.tracker.update(setOf("a"))
        advanceTimeBy(1_499); runCurrent()
        assertEquals(emptyList(), r.log)
        advanceTimeBy(2); runCurrent()
        assertEquals(listOf("join a"), r.log)
    }

    @Test
    fun walkingThroughWithoutDwellingNeverJoinsOrLeaves() = runTest {
        val r = Rig(backgroundScope)
        r.tracker.update(setOf("a")); advanceTimeBy(800); runCurrent()
        r.tracker.update(emptySet()); advanceTimeBy(10_000); runCurrent()
        assertEquals(emptyList(), r.log)
    }

    // Pose updates arrive constantly; repeating the same answer must not restart the timers.
    @Test
    fun repeatingTheSameAreaDoesNotRestartTheDwell() = runTest {
        val r = Rig(backgroundScope)
        r.tracker.update(setOf("a")); advanceTimeBy(1_000); r.tracker.update(setOf("a")); advanceTimeBy(400); r.tracker.update(setOf("a"))
        advanceTimeBy(150); runCurrent()
        assertEquals(listOf("join a"), r.log)
    }

    @Test
    fun leavesOnlyAfterTheLingerTimeAndWalkingBackInCancelsTheLeave() = runTest {
        val r = Rig(backgroundScope)
        r.tracker.update(setOf("a")); advanceTimeBy(1_600); runCurrent()
        r.tracker.update(emptySet()); advanceTimeBy(2_000); runCurrent()
        assertEquals(listOf("join a"), r.log) // still lingering
        r.tracker.update(setOf("a")); advanceTimeBy(5_000); runCurrent()
        assertEquals(listOf("join a"), r.log) // walked back in: stayed
        r.tracker.update(emptySet()); advanceTimeBy(2_600); runCurrent()
        assertEquals(listOf("join a", "leave a"), r.log)
    }

    @Test
    fun overlappingAreasAreTrackedIndependently() = runTest {
        val r = Rig(backgroundScope)
        r.tracker.update(setOf("a")); advanceTimeBy(1_000)
        r.tracker.update(setOf("a", "b")); advanceTimeBy(600); runCurrent()
        assertEquals(listOf("join a"), r.log)
        advanceTimeBy(1_000); runCurrent()
        assertEquals(listOf("join a", "join b"), r.log)
        r.tracker.update(setOf("b")); advanceTimeBy(2_600); runCurrent()
        assertEquals(listOf("join a", "join b", "leave a"), r.log)
    }

    @Test
    fun closeCancelsPendingTimers() = runTest {
        val r = Rig(backgroundScope)
        r.tracker.update(setOf("a")); r.tracker.close(); advanceTimeBy(10_000); runCurrent()
        assertEquals(emptyList(), r.log)
    }
}
