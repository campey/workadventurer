package app.workadventurer.protocol

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

// WorkAdventure's own rule when a room has no start AREA in its .wam: the player starts on a tile of the Tiled map's "start"
// layer (or of a layer flagged startLayer=true). Seen on levelup-npc/lean-iterator/campus, which has only tile start layers;
// we used to drop the avatar at a fixed corner (320,320), where it saw nobody.
class TmjSpawnTest {
    private fun tmj(layers: String, w: Int = 5, h: Int = 4) = """{"width":$w,"height":$h,"tilewidth":32,"tileheight":32,"layers":$layers}"""
    private fun layer(name: String, data: List<Int>, props: String = "") =
        """{"type":"tilelayer","name":"$name","data":[${data.joinToString(",")}]$props}"""
    private val startFlag = ""","properties":[{"name":"startLayer","type":"bool","value":true}]"""
    private fun cells(vararg at: Pair<Int, Int>, w: Int = 5, h: Int = 4) = List(w * h) { i -> if ((i % w) to (i / w) in at) 7 else 0 }

    @Test
    fun startsOnTheCentreOfATileOfTheStartLayer() {
        val s = pickTmjSpawn(tmj("[${layer("start", cells(2 to 1))}]"))
        assertEquals(Spawn(2 * 32 + 16, 1 * 32 + 16, "start"), s)
    }

    @Test
    fun anyTileOfTheLayerIsAValidChoice() {
        val t = tmj("[${layer("start", cells(0 to 0, 4 to 3, 2 to 2))}]")
        val centres = setOf(16 to 16, 4 * 32 + 16 to 3 * 32 + 16, 2 * 32 + 16 to 2 * 32 + 16)
        repeat(20) { assertTrue(pickTmjSpawn(t, Random(it))!!.let { s -> s.x to s.y } in centres) }
    }

    @Test
    fun theStartLayerBeatsOtherStartLayers() {
        val t = tmj("[${layer("east", cells(4 to 0), startFlag)},${layer("start", cells(1 to 1))},${layer("west", cells(0 to 3), startFlag)}]")
        assertEquals("start", pickTmjSpawn(t)!!.area)
    }

    @Test
    fun aFlaggedStartLayerIsUsedWhenThereIsNoUsableStartLayer() {
        val empty = tmj("[${layer("start", cells())},${layer("east", cells(4 to 0), startFlag)}]")
        assertEquals(Spawn(4 * 32 + 16, 16, "east"), pickTmjSpawn(empty))
        val missing = tmj("[${layer("west", cells(0 to 3), startFlag)}]")
        assertEquals("west", pickTmjSpawn(missing)!!.area)
    }

    @Test
    fun startLayersInsideGroupsAreFound() {
        val t = tmj("""[{"type":"group","name":"g","layers":[${layer("start", cells(3 to 2))}]}]""")
        assertEquals(Spawn(3 * 32 + 16, 2 * 32 + 16, "start"), pickTmjSpawn(t))
    }

    @Test
    fun noStartLayerAtAllOrGarbageGivesNull() {
        assertNull(pickTmjSpawn(tmj("[${layer("collisions", cells(1 to 1))}]")))
        assertNull(pickTmjSpawn("{{{ nope"))
        assertNull(pickTmjSpawn("""{"layers":[]}""")) // no width/height
        assertNull(pickTmjSpawn(tmj("""[{"type":"tilelayer","name":"start","data":"AAAA","encoding":"base64"}]""")))
    }
}
