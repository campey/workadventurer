package app.workadventurer.nav

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** '#' = blocked, anything else free. */
fun gridOf(vararg rows: String, tile: Int = 32): NavGrid {
    val h = rows.size
    val w = rows[0].length
    require(rows.all { it.length == w })
    return NavGrid(w, h, tile, BooleanArray(w * h) { rows[it / w][it % w] == '#' })
}

class NavGridTest {
    @Test
    fun tileMathUsesFloorAndCentres() {
        val g = gridOf("....", "....", "....")
        assertEquals(1 to 2, g.pxToTile(40.0, 70.0))
        assertEquals(Pt(16.0, 16.0), g.tileCenterPx(0, 0))
        assertEquals(Pt(48.0, 80.0), g.tileCenterPx(1, 2))
        assertEquals(-1 to -1, g.pxToTile(-0.5, -31.9)) // floor, not truncation toward zero
    }

    @Test
    fun outOfBoundsCountsAsBlocked() {
        val g = gridOf("..", "..")
        assertTrue(g.isTileBlocked(-1, 0)); assertTrue(g.isTileBlocked(0, 2)); assertTrue(g.isTileBlocked(2, 0))
        assertFalse(g.isTileBlocked(1, 1))
        assertTrue(g.isPxBlocked(-5.0, 10.0))
    }

    @Test
    fun nearestFreeReturnsSelfWhenFreeAndSpiralsOutWhenBlocked() {
        val g = gridOf(".....", ".###.", ".#.#.", ".###.", ".....")
        assertEquals(2 to 2, g.nearestFree(2, 2)) // already free: returned as is
        // (1,1) is blocked; ring 1 in raster order starts at (0,0), which is free
        assertEquals(0 to 0, g.nearestFree(1, 1))
    }

    @Test
    fun nearestFreeGivesUpWhenNothingIsFreeWithinRange() {
        val g = NavGrid(3, 3, 32, BooleanArray(9) { true })
        assertNull(g.nearestFree(1, 1))
    }

    @Test
    fun bakedJsonRoundTrips() {
        val json = """{"source":{"room":"x"},"width":3,"height":2,"tile":32,"blocked":[1,4],"start":[],"areas":[]}"""
        val g = NavGrid.fromBakedJson(json)
        assertEquals(3, g.w); assertEquals(2, g.h); assertEquals(32, g.tile)
        assertTrue(g.isTileBlocked(1, 0)); assertTrue(g.isTileBlocked(1, 1)); assertFalse(g.isTileBlocked(0, 0))
        assertEquals(listOf(1, 4), g.blockedIndices().toList())
    }

    @Test
    fun badGridShapeIsRejected() {
        val e = runCatching { NavGrid(2, 2, 32, BooleanArray(3)) }.exceptionOrNull()
        assertTrue(e is IllegalArgumentException)
    }
}
