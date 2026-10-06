package app.workadventurer.nav

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.hypot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PathfindingTest {
    private fun at(g: NavGrid, tx: Int, ty: Int) = g.tileCenterPx(tx, ty)

    /** Every consecutive pair of waypoints must be walkable tile-to-tile. */
    private fun assertWalkable(g: NavGrid, path: List<Pt>) {
        for ((a, b) in path.zipWithNext()) {
            val n = (hypot(b.x - a.x, b.y - a.y) / 4).toInt().coerceAtLeast(1)
            for (i in 0..n) {
                val x = a.x + (b.x - a.x) * i / n
                val y = a.y + (b.y - a.y) * i / n
                assertTrue(!g.isPxBlocked(x, y), "walked into a wall at $x,$y")
            }
        }
    }

    @Test
    fun openGroundSmoothsToTwoPoints() {
        val g = gridOf("......", "......", "......")
        val p = g.findPath(at(g, 0, 0), at(g, 5, 2))!!
        assertEquals(listOf(at(g, 0, 0), at(g, 5, 2)), p)
    }

    @Test
    fun startEqualsGoalTileIsASinglePoint() {
        val g = gridOf("...", "...")
        assertEquals(listOf(at(g, 1, 1)), g.findPath(Pt(40.0, 40.0), Pt(50.0, 45.0)))
    }

    @Test
    fun routesThroughTheGapInAWall() {
        val g = gridOf(
            ".....#.....",
            ".....#.....",
            ".....#.....",
            "...........",
            ".....#.....",
            ".....#.....",
        )
        val p = g.findPath(at(g, 1, 0), at(g, 9, 5))!!
        // Column 5 is solid except row 3, so a walkable path must bend through the gap.
        assertWalkable(g, p)
        assertTrue(p.size >= 3, "expected a bend through the gap, got $p")
        assertEquals(at(g, 1, 0), p.first())
        assertEquals(at(g, 9, 5), p.last())
    }

    @Test
    fun noDiagonalCornerCutting() {
        // The only link between the two halves is a diagonal squeeze between two blocked tiles.
        val g = gridOf("..#", ".#.", "#..")
        // (0,0)-(1,0)-(0,1) is the top-left pocket; (2,1),(1,2),(2,2) the bottom-right one.
        assertNull(g.findPath(at(g, 0, 0), at(g, 2, 2)))
    }

    @Test
    fun startSealedInsideAPocketIsUnreachable() {
        val g = gridOf("#####", "#.#..", "#####")
        assertNull(g.findPath(at(g, 1, 1), at(g, 4, 1)))
    }

    @Test
    fun startInsideAWallSnapsToTheNearestFreeTile() {
        val g = gridOf(".....", ".###.", ".###.", ".....")
        val p = g.findPath(at(g, 2, 1), at(g, 4, 3))
        assertNotNull(p)
        assertTrue(!g.isPxBlocked(p.first().x, p.first().y), "path must start on a free tile")
    }

    @Test
    fun matchesTheNodeImplementationOnTheRealAfrolabsMap() {
        val res = PathfindingTest::class.java
        val grid = NavGrid.fromBakedJson(res.getResource("/afrolabs-collision.json")!!.readText())
        val cases = Json.parseToJsonElement(res.getResource("/afrolabs-paths.json")!!.readText()).jsonArray
        assertTrue(cases.size >= 40)
        var reachable = 0
        for ((i, c) in cases.withIndex()) {
            val o = c.jsonObject
            val from = o.getValue("from").jsonArray.map { it.jsonPrimitive.double }
            val to = o.getValue("to").jsonArray.map { it.jsonPrimitive.double }
            val expected = o.getValue("path")
            val actual = grid.findPath(Pt(from[0], from[1]), Pt(to[0], to[1]))
            if (expected is JsonNull) {
                assertNull(actual, "case $i: Node found no path, Kotlin did")
            } else {
                reachable++
                val exp = (expected as JsonArray).map { p -> p.jsonArray.map { it.jsonPrimitive.double } }
                assertEquals(exp.map { Pt(it[0], it[1]) }, actual, "case $i from=$from to=$to")
            }
        }
        assertTrue(reachable > 20, "fixture should contain plenty of reachable cases, had $reachable")
    }
}
