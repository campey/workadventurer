package app.workadventurer.nav

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CollisionBuilderTest {
    // 5 x 4 map, tile 32, indices 0..19 row-major.
    private fun tmj(layers: String, tilesets: String = "[]", w: Int = 5, h: Int = 4) =
        """{"width":$w,"height":$h,"tilewidth":32,"tileheight":32,"tilesets":$tilesets,"layers":$layers}"""

    private val noWam = """{"entities":{},"areas":[]}"""

    @Test
    fun collisionsLayerBlocksEveryNonZeroCell() {
        val g = CollisionBuilder.build(
            noWam,
            tmj("""[{"type":"tilelayer","name":"collisions","data":[0,0,5,0,0, 0,0,0,0,0, 7,0,0,0,0, 0,0,0,0,3]}]"""),
        )!!
        assertEquals(listOf(2, 10, 19), g.blockedIndices().toList())
        assertEquals(5, g.w); assertEquals(4, g.h); assertEquals(32, g.tile)
    }

    @Test
    fun collidesTilesetTilesBlockTheirCellsOnAnyLayerAndFlipFlagsAreStripped() {
        // firstgid 10, tile id 2 collides -> gid 12. Cell 4 holds gid 12 with the horizontal-flip bit (0x80000000) set.
        val flipped = 12L or 0x80000000L
        val g = CollisionBuilder.build(
            noWam,
            tmj(
                """[{"type":"tilelayer","name":"walls","data":[0,0,0,0,$flipped, 0,12,0,0,0, 0,0,0,0,0, 0,0,0,0,11]}]""",
                """[{"firstgid":10,"tiles":[{"id":2,"properties":[{"name":"collides","value":true}]},{"id":1,"properties":[{"name":"collides","value":false}]}]}]""",
            ),
        )!!
        assertEquals(listOf(4, 6), g.blockedIndices().toList()) // cell 19 holds gid 11 (collides=false): free
    }

    @Test
    fun stringTrueCountsAndGroupLayersAreFlattened() {
        val g = CollisionBuilder.build(
            noWam,
            tmj(
                """[{"type":"group","name":"g","layers":[{"type":"tilelayer","name":"inner","data":[3,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0]}]}]""",
                """[{"firstgid":1,"tiles":[{"id":2,"properties":[{"name":"collides","value":"true"}]}]}]""",
            ),
        )!!
        assertEquals(listOf(0), g.blockedIndices().toList())
    }

    @Test
    fun wamEntitiesBlockTheirFootprint() {
        // stool at (64,32) -> tile (2,1) only; table at (96,64) -> centre tile (3,2) plus the 3x3 around it.
        val wam = """{"entities":{
            "a":{"x":64,"y":32,"prefabRef":{"id":"LimeZu:Bar Stool:#fff:Down"}},
            "b":{"x":96,"y":64,"prefabRef":{"id":"LimeZu:Big Table"}}}}"""
        val g = CollisionBuilder.build(wam, tmj("""[{"type":"tilelayer","name":"x","data":[]}]"""))!!
        val blocked = g.blockedIndices().toSet()
        assertTrue(7 in blocked) // stool tile (2,1) = 1*5+2
        // table: tiles x 2..4, y 1..3 clipped to the 5x4 map
        for (ty in 1..3) for (tx in 2..4) assertTrue(ty * 5 + tx in blocked, "tile ($tx,$ty)")
        assertEquals(9, blocked.size) // 3x3 block includes the stool's tile; nothing else
    }

    @Test
    fun entitiesOutsideTheMapAreIgnored() {
        val wam = """{"entities":{"a":{"x":-500,"y":9000,"prefabRef":{"id":"Table"}}}}"""
        val g = CollisionBuilder.build(wam, tmj("""[]"""))!!
        assertEquals(0, g.blockedIndices().size)
    }

    @Test
    fun aDataArrayLongerThanTheMapDoesNotOverflow() {
        // 25 non-zero cells on a 20-cell map: the extra five are ignored, the 20 real ones are blocked.
        val g = CollisionBuilder.build(
            noWam,
            tmj("""[{"type":"tilelayer","name":"collisions","data":[1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1]}]"""),
        )!!
        assertEquals(20, g.blockedIndices().size)
    }

    @Test
    fun degradesInsteadOfThrowingOnRealWorldQuirks() {
        // an object layer (no data), an external tileset (source only, no inline tiles), an entity without x/y,
        // and wrongly-typed fields: none of it may throw; unusable parts are skipped
        val g = CollisionBuilder.build(
            """{"entities":{"a":{"prefabRef":{}},"b":{"x":"left","y":[1],"prefabRef":"nope"},"c":7}}""",
            tmj(
                """[{"type":"objectgroup","name":"floorLayer","objects":[]},
                    {"type":"tilelayer","name":"collisions","data":[1,"x",null,1,1, 1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1]}]""",
                """[{"firstgid":1,"source":"external.tsx"},{"firstgid":"bad","tiles":5}]""",
            ),
        )
        assertNotNull(g)
        // cells 1 ("x") and 2 (null) aren't numbers and are skipped; the other 18 are blocked. No crash.
        assertEquals((0 until 20).filter { it != 1 && it != 2 }, g.blockedIndices().toList())
    }

    @Test
    fun unusableTmjYieldsNull() {
        assertNull(CollisionBuilder.build(noWam, "not json"))
        assertNull(CollisionBuilder.build(noWam, """{"layers":[]}"""))
        assertNull(CollisionBuilder.build(noWam, """{"width":0,"height":3,"tilewidth":32,"layers":[]}"""))
    }

    @Test
    fun aGarbledWamStillGivesTheTmjCollisions() {
        val g = CollisionBuilder.build(
            "{{{ nope",
            tmj("""[{"type":"tilelayer","name":"collisions","data":[1,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0]}]"""),
        )!!
        assertEquals(listOf(0), g.blockedIndices().toList())
    }
}
