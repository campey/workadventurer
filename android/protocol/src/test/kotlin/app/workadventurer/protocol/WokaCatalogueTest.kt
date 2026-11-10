package app.workadventurer.protocol

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import java.io.IOException

class WokaCatalogueTest {
    // Trimmed from a live GET /woka/list on prod (2026-10-27): whole wokas live under "woka", the other parts are layers.
    private val json = """
        {
          "woka": {"collections": [
            {"name": "Default Collection", "position": 0, "textures": [
              {"id": "506a3a64-47a9-4587-b19b-2d1eb13f9790", "name": "Bob", "url": "https://admin.workadventu.re/wokas/Character_full/Full1.png"},
              {"id": "0197b521-4794-4a83-be13-d1bf77d91367", "name": "Steve", "url": "wokas/Character_full/Full2.png"}
            ]},
            {"name": "Legacy Collection", "position": 1, "textures": [
              {"id": "aaaa", "name": "Old", "url": "https://admin.workadventu.re/wokas/legacy/1.png"}
            ]}
          ]},
          "hair": {"collections": [
            {"name": "Default Collection", "textures": [{"id": "d72a4c1e", "name": "Bald", "url": "https://admin.workadventu.re/wokas/empty.png"}]}
          ]}
        }
    """.trimIndent()

    @Test
    fun wholeWokasAreTheWokaPartsCollectionsInOrder() {
        val c = parseWokaCatalogue(json, "https://pusher.workadventu.re")
        assertEquals(listOf("Default Collection", "Legacy Collection"), c.wokas.map { it.name })
        assertEquals(listOf("Bob", "Steve"), c.wokas[0].textures.map { it.name })
        assertEquals("506a3a64-47a9-4587-b19b-2d1eb13f9790", c.wokas[0].textures[0].id)
    }

    // The web client puts the pusher's address in front of a relative picture address.
    @Test
    fun aRelativePictureAddressIsResolvedAgainstThePusher() {
        val c = parseWokaCatalogue(json, "https://pusher.workadventu.re")
        assertEquals("https://admin.workadventu.re/wokas/Character_full/Full1.png", c.wokas[0].textures[0].url)
        assertEquals("https://pusher.workadventu.re/wokas/Character_full/Full2.png", c.wokas[0].textures[1].url)
    }

    @Test
    fun findsAWokaByIdAndNullWhenTheCatalogueDoesNotHaveIt() {
        val c = parseWokaCatalogue(json, "https://pusher.workadventu.re")
        assertEquals("Old", c.findWoka("aaaa")?.name)
        assertNull(c.findWoka("nope"))
    }

    @Test
    fun otherPartsAreKeptForLater() {
        val c = parseWokaCatalogue(json, "https://pusher.workadventu.re")
        assertEquals(listOf("hair", "woka"), c.parts.keys.sorted())
    }

    @Test
    fun aCatalogueWithNoWokaPartHasNoWokas() {
        assertEquals(emptyList(), parseWokaCatalogue("{}", "https://p").wokas)
    }

    @Test
    fun garbageIsAnErrorNotAnEmptyCatalogue() {
        assertFailsWith<IOException> { parseWokaCatalogue("<html>", "https://p") }
    }

    // GET {pusher}/woka/list?roomUrl=<room> with the bare token (no "Bearer"), as the web client does.
    @Test
    fun fetchAsksForTheRoomsCatalogueWithTheBareToken() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(json))
            server.start()
            val cfg = RoomConfig(roomUrl = "https://play.workadventu.re/@/a/b/c", pusherUrl = server.url("/").toString().trimEnd('/'), name = "n")
            val c = fetchWokaCatalogue(OkHttpClient(), cfg, "TOKEN")
            val req = server.takeRequest()
            assertEquals("TOKEN", req.getHeader("Authorization"))
            assertEquals("/woka/list?roomUrl=https%3A%2F%2Fplay.workadventu.re%2F%40%2Fa%2Fb%2Fc", req.path)
            assertEquals(2, c.wokas[0].textures.size)
        }
    }

    @Test
    fun aRefusedFetchIsAnError() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(401))
            server.start()
            val cfg = RoomConfig(pusherUrl = server.url("/").toString().trimEnd('/'), name = "n")
            assertFailsWith<IOException> { fetchWokaCatalogue(OkHttpClient(), cfg, "T") }
        }
    }
}
