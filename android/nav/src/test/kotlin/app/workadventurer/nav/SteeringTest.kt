package app.workadventurer.nav

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SteeringTest {
    @Test
    fun faceTowardPicksTheDominantAxis() {
        assertEquals(Facing.RIGHT, faceToward(0.0, 0.0, 10.0, 3.0))
        assertEquals(Facing.LEFT, faceToward(0.0, 0.0, -10.0, 3.0))
        assertEquals(Facing.DOWN, faceToward(0.0, 0.0, 3.0, 10.0))
        assertEquals(Facing.UP, faceToward(0.0, 0.0, 3.0, -10.0))
        assertEquals(Facing.UP, faceToward(0.0, 0.0, 0.0, 0.0)) // no direction falls through to UP, as in the Node client
    }

    @Test
    fun standOffPointStandsShortOnTheApproachSide() {
        val p = standOffPoint(me = Pt(0.0, 0.0), target = Pt(100.0, 0.0), spacing = 72.0)
        assertEquals(28.0, p.x, 1e-9) // 72 px short of the target, on our side
        assertEquals(0.0, p.y, 1e-9)
    }

    @Test
    fun standOffPointOnTopOfTheTargetStepsBelowIt() {
        val p = standOffPoint(me = Pt(100.0, 100.0), target = Pt(100.0, 100.0), spacing = 72.0)
        assertEquals(Pt(100.0, 172.0), p)
    }

    @Test
    fun standOffPointSnapsOffABlockedTile() {
        val g = gridOf("...", ".#.", "...")
        // target right of the wall; the approach point lands on the blocked tile (1,1)
        val p = standOffPoint(me = Pt(16.0, 48.0), target = Pt(48.0 + 40.0, 48.0), spacing = 40.0, grid = g)
        assertTrue(!g.isPxBlocked(p.x, p.y), "point $p is still blocked")
    }

    @Test
    fun frontOfStandsInTheirEyeline() {
        assertEquals(Pt(100.0, 136.0), frontOf(Target(100.0, 100.0, Facing.DOWN), me = Pt(0.0, 0.0), spacing = 36.0))
        assertEquals(Pt(64.0, 100.0), frontOf(Target(100.0, 100.0, Facing.LEFT), me = Pt(0.0, 0.0), spacing = 36.0))
        assertEquals(Pt(100.0, 64.0), frontOf(Target(100.0, 100.0, Facing.UP), me = Pt(0.0, 0.0), spacing = 36.0))
        assertEquals(Pt(136.0, 100.0), frontOf(Target(100.0, 100.0, Facing.RIGHT), me = Pt(0.0, 0.0), spacing = 36.0))
    }

    @Test
    fun frontOfSnapsToAFreeTileWhenTheSpotIsBlocked() {
        val g = gridOf(".....", ".....", ".##..", ".....")
        // target at tile (1,1) facing down; 32px in front is tile (1,2), which is a wall
        val p = frontOf(Target(48.0, 48.0, Facing.DOWN), me = Pt(0.0, 0.0), spacing = 32.0, grid = g)
        assertTrue(!g.isPxBlocked(p.x, p.y), "point $p is blocked")
    }

    @Test
    fun frontOfFallsBackToTheNearestFreePointInBubbleRangeNotARasterNeighbour() {
        // Facing UP on the top row: the front spot is off the map. The old snap took the first free tile in raster
        // order, which was 62 px from the player: a walk "arrived" outside bubble range and no bubble formed.
        val g = NavGrid(20, 5, 32, BooleanArray(100))
        val p = frontOf(Target(300.0, 0.0, Facing.UP), me = Pt(0.0, 0.0), spacing = 40.0, grid = g)
        assertTrue(!g.isPxBlocked(p.x, p.y), "point $p is blocked")
        assertEquals(40.0, kotlin.math.hypot(p.x - 300.0, p.y), 1e-6) // exactly the bubble spacing from the player
        assertTrue(p.x < 300.0, "should be on our side of the player, got $p")
    }

    @Test
    fun frontOfWithAWallInFrontStandsBesideThePlayerWithinRange() {
        val g = gridOf("..........", "..........", "....#.....", "..........")
        // Target at tile (4,1) centre (144,48), facing DOWN; its front spot (144,88) is the wall tile (4,2)
        val p = frontOf(Target(144.0, 48.0, Facing.DOWN), me = Pt(16.0, 48.0), spacing = 40.0, grid = g)
        assertTrue(!g.isPxBlocked(p.x, p.y))
        assertTrue(kotlin.math.hypot(p.x - 144.0, p.y - 48.0) <= 48.0, "out of bubble range: $p")
    }

    @Test
    fun snapToFreeReturnsTheSamePointWhenFreeAndAFreeTileCentreWhenBlocked() {
        val g = gridOf("...", ".#.", "...")
        assertEquals(Pt(10.0, 10.0), g.snapToFree(10.0, 10.0))
        val s = g.snapToFree(48.0, 48.0)!! // the blocked middle tile
        assertTrue(!g.isPxBlocked(s.x, s.y))
        assertNull(NavGrid(2, 2, 32, BooleanArray(4) { true }).snapToFree(10.0, 10.0))
    }
}
