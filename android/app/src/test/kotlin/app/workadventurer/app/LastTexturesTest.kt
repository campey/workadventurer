package app.workadventurer.app

import app.workadventurer.protocol.Texture
import kotlin.test.Test
import kotlin.test.assertEquals

class LastTexturesTest {
    private class MemoryStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String) { values[key] = value }
    }

    private val prod = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space"
    private val staging = "https://play.staging.workadventu.re/@/tcm/workadventure/wa-village"
    private val layers = listOf(Texture("body", "https://x/body.png"), Texture("hair", "https://x/hair.png"))

    @Test
    fun nothingIsKnownBeforeTheFirstJoin() {
        assertEquals(emptyList(), LastTextures(MemoryStore()).get(prod))
    }

    @Test
    fun theLayersComeBackInOrderNextTime() {
        val store = MemoryStore()
        LastTextures(store).remember(prod, layers)
        assertEquals(layers, LastTextures(store).get(prod)) // a new instance, as after an app restart
    }

    // The woka is the server's: prod and staging have different catalogues, so each remembers its own.
    @Test
    fun eachServerRemembersItsOwn() {
        val store = MemoryStore()
        LastTextures(store).remember(prod, layers)
        assertEquals(emptyList(), LastTextures(store).get(staging))
        val other = listOf(Texture("leo", "https://x/leo.png"))
        LastTextures(store).remember(staging, other)
        assertEquals(layers, LastTextures(store).get(prod))
        assertEquals(other, LastTextures(store).get(staging))
    }

    @Test
    fun twoRoomsOnTheSameServerShareOne() {
        val store = MemoryStore()
        LastTextures(store).remember(prod, layers)
        assertEquals(layers, LastTextures(store).get("https://play.workadventu.re/@/levelup-npc/lean-iterator/campus"))
    }

    // An empty list means we were told nothing: it must not wipe a good remembered picture.
    @Test
    fun anEmptyListDoesNotOverwrite() {
        val store = MemoryStore()
        LastTextures(store).remember(prod, layers)
        LastTextures(store).remember(prod, emptyList())
        assertEquals(layers, LastTextures(store).get(prod))
    }

    // What is read back is fetched later, so only plain https layers are ever accepted, and a corrupt store is just "nothing".
    @Test
    fun onlyHttpsLayersAreKeptAndGarbageIsIgnored() {
        val store = MemoryStore()
        store.put("last_textures_prod", "body\thttps://x/body.png\nevil\thttp://x/plain.png\nfile\tfile:///etc/passwd\nbroken line\n\thttps://x/noid.png\nhair\thttps://x/hair.png")
        assertEquals(listOf(Texture("body", "https://x/body.png"), Texture("hair", "https://x/hair.png")), LastTextures(store).get(prod))
        store.put("last_textures_prod", "\u0000\u0001 not a list")
        assertEquals(emptyList(), LastTextures(store).get(prod))
    }

    @Test
    fun aWokaIsBoundedInSize() {
        val store = MemoryStore()
        LastTextures(store).remember(prod, (1..50).map { Texture("t$it", "https://x/$it.png") })
        assertEquals(12, LastTextures(store).get(prod).size)
    }
}
