package app.workadventurer.nav

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.math.hypot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeSink(start: Pt) : MovementSink {
    class Move(val x: Double, val y: Double, val facing: Facing, val moving: Boolean)

    var pos = start
    val moves = mutableListOf<Move>()
    override fun position() = pos
    override fun move(x: Double, y: Double, facing: Facing, moving: Boolean) {
        pos = Pt(x, y)
        moves += Move(x, y, facing, moving)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class NavigatorTest {
    @Test
    fun walkToArrivesInStepsNoLargerThanStepPxAndEndsStopped() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        assertEquals(Outcome.ARRIVED, nav.walkTo(Pt(320.0, 0.0), stopWithin = 12.0, stepPx = 32.0))
        var prev = Pt(0.0, 0.0)
        for (m in sink.moves.filter { it.moving }) {
            assertTrue(hypot(m.x - prev.x, m.y - prev.y) <= 32.0 + 1e-6)
            prev = Pt(m.x, m.y)
        }
        assertTrue(sink.pos.x >= 308.0)
        assertFalse(sink.moves.last().moving)
        assertEquals(Facing.RIGHT, sink.moves.last().facing)
        assertEquals(1, sink.moves.count { !it.moving }, "exactly one final stop")
    }

    @Test
    fun walkToStopsWhenTheTargetIsGone() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        var calls = 0
        val r = nav.walkTo(Pt(0.0, 0.0), getTarget = { if (calls++ < 3) Pt(500.0, 0.0) else null })
        assertEquals(Outcome.TARGET_GONE, r)
        assertFalse(sink.moves.last().moving)
    }

    @Test
    fun walkToTimesOutAndStillSendsAFinalStop() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        assertEquals(Outcome.TIMEOUT, nav.walkTo(Pt(100_000.0, 0.0), timeoutMs = 500))
        assertFalse(sink.moves.last().moving)
    }

    @Test
    fun cancellingMidWalkSendsAFinalStop() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        val job = launch { nav.walkTo(Pt(100_000.0, 0.0)) }
        advanceTimeBy(500); runCurrent()
        assertTrue(sink.moves.last().moving)
        job.cancel(); runCurrent()
        assertFalse(sink.moves.last().moving)
    }

    private val wallWithGap = gridOf(
        ".......#......",
        ".......#......",
        ".......#......",
        ".......#......",
        ".......#......",
        "..............",
        "..............",
    )

    /** How far (px) a point is inside a blocked tile, measured to the nearest tile edge; 0 on a free tile. */
    private fun depthInWall(g: NavGrid, x: Double, y: Double): Double {
        if (!g.isPxBlocked(x, y)) return 0.0
        val (tx, ty) = g.pxToTile(x, y)
        val t = g.tile.toDouble()
        return minOf(x - tx * t, (tx + 1) * t - x, y - ty * t, (ty + 1) * t - y)
    }

    @Test
    fun navToRoutesAroundAWallAndOnlyEverGrazesItsCorners() = runTest {
        val g = wallWithGap
        val start = g.tileCenterPx(1, 2)
        val sink = FakeSink(start)
        val nav = Navigator({ g }, sink, { testScheduler.currentTime })
        val goal = g.tileCenterPx(12, 2)
        assertEquals(Outcome.ARRIVED, nav.navTo(goal, stopWithin = 24.0))
        // The smoothing (a port of Node's) guarantees line-of-sight between tile CENTRES, not geometric clearance,
        // so a straight leg may graze a wall corner by a few px. It must never go meaningfully into the wall.
        for (m in sink.moves) {
            val depth = depthInWall(g, m.x, m.y)
            assertTrue(depth <= 12.0, "went ${"%.1f".format(depth)} px into a wall at ${m.x},${m.y}")
        }
        assertTrue(sink.moves.any { it.x > 8 * 32.0 }, "never made it through the gap to the far side")
        assertTrue(hypot(sink.pos.x - goal.x, sink.pos.y - goal.y) <= 24.0)
        assertFalse(sink.moves.last().moving)
    }

    @Test
    fun navToFacesTheGivenPointOnArrival() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        nav.navTo(Pt(100.0, 0.0), stopWithin = 12.0, face = { Pt(100.0, 500.0) })
        assertEquals(Facing.DOWN, sink.moves.last().facing)
        assertFalse(sink.moves.last().moving)
    }

    @Test
    fun navToWithNoPathDegradesToStraightLineAndTerminates() = runTest {
        // start sealed in a pocket: A* finds nothing, so we walk straight (through the wall) rather than spin or give up
        val g = gridOf("#####", "#.#..", "#####")
        val sink = FakeSink(g.tileCenterPx(1, 1))
        val nav = Navigator({ g }, sink, { testScheduler.currentTime })
        assertEquals(Outcome.ARRIVED, nav.navTo(g.tileCenterPx(4, 1), stopWithin = 12.0))
        assertTrue(sink.moves.isNotEmpty())
    }

    @Test
    fun navToNeverSpinsWhenTheGoalIsUnreachableInTime() = runTest {
        // no grid and a goal 100 km away: must hit the timeout with a bounded number of messages (one per tick), not spin
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        assertEquals(Outcome.TIMEOUT, nav.navTo(Pt(100_000.0, 0.0), timeoutMs = 2_000))
        assertTrue(sink.moves.size < 40, "sent ${sink.moves.size} messages in 2 s of virtual time")
    }

    @Test
    fun navToStopsWhenTheTargetIsGone() = runTest {
        val sink = FakeSink(Pt(0.0, 0.0))
        val nav = Navigator({ null }, sink, { testScheduler.currentTime })
        var calls = 0
        val r = nav.navTo(Pt(0.0, 0.0), getTarget = { if (calls++ < 2) Pt(5_000.0, 0.0) else null })
        assertEquals(Outcome.TARGET_GONE, r)
    }
}
