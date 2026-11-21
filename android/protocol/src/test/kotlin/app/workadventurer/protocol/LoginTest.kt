package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class LoginTest {
    @Test
    fun anonymLoginPostsEmptyJsonAndParsesToken() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"authToken":"tok123","userUuid":"u-1","extra":1}"""))
            server.start()
            val cfg = RoomConfig(pusherUrl = server.url("/").toString().trimEnd('/'), name = "t")
            val login = anonymLogin(OkHttpClient(), cfg)
            assertEquals(Login("tok123", "u-1"), login)
            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("/anonymLogin", req.path)
            assertEquals("{}", req.body.readUtf8())
        }
    }

    @Test
    fun anonymLoginFailureIncludesStatusAndBody() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503).setBody("nope"))
            server.start()
            val cfg = RoomConfig(pusherUrl = server.url("/").toString().trimEnd('/'), name = "t")
            val e = assertFailsWith<IOException> { anonymLogin(OkHttpClient(), cfg) }
            assertEquals("anonymLogin failed: 503 nope", e.message)
        }
    }

    @Test
    fun wsUrlUsesApiVersionHashOverride() {
        // For probing a server build that has no adapter yet (mirrors the Node client's WA_VERSION).
        val u = wsUrl(RoomConfig(name = "n", apiVersionHash = "b82fc568"), tabId = "t")
        assertEquals("b82fc568", u.queryParameter("version"))
    }

    @Test
    fun wsUrlCarriesRoomWokaVersionAndMediaState() {
        val cfg = RoomConfig(name = "n", micOn = false)
        val u = wsUrl(cfg, tabId = "abc123abc123")
        assertEquals("/ws/room", u.encodedPath)
        assertEquals(Wa133.DEFAULT_ROOM, u.queryParameter("roomId"))
        assertEquals(listOf(Wa133.DEFAULT_WOKA), u.queryParameterValues("characterTextureIds"))
        assertEquals("f4cfe455", u.queryParameter("version")) // prod v1.34.4 (see field-notes)
        assertEquals("false", u.queryParameter("microphoneState"))
        assertEquals("false", u.queryParameter("cameraState"))
        assertEquals("abc123abc123", u.queryParameter("tabId"))
        assertEquals("pusher.workadventu.re", u.host)
    }

    @Test
    fun wsUrlIsUnchangedWhenTheHandshakeQueryIsEmpty() {
        val base = RoomConfig(name = "n")
        assertEquals(wsUrl(base, "t").toString(), wsUrl(base.copy(handshakeQuery = emptyMap()), "t").toString())
        assertEquals(9, wsUrl(base, "t").querySize)
    }

    @Test
    fun wsUrlAppendsHandshakeQuery() {
        val u = wsUrl(RoomConfig(name = "n", handshakeQuery = mapOf("extra" to "a.b-1")), "t")
        assertEquals("a.b-1", u.queryParameter("extra"))
        assertEquals(9, u.querySize - 1)
    }

    @Test
    fun wsUrlHandshakeQueryNeverOverridesClientParameters() {
        val cfg = RoomConfig(name = "n", handshakeQuery = mapOf("tabId" to "x", "microphoneState" to "true", "roomName" to "r", "chatID" to "c"))
        val u = wsUrl(cfg, "tab1")
        assertEquals(listOf("tab1"), u.queryParameterValues("tabId"))
        assertEquals(listOf("false"), u.queryParameterValues("microphoneState"))
        assertEquals(listOf(""), u.queryParameterValues("roomName"))
        assertEquals(9, u.querySize)
    }

    @Test
    fun wsUrlHandshakeQueryDropsForbiddenNamesCaseInsensitively() {
        val cfg = RoomConfig(
            name = "n",
            handshakeQuery = mapOf("roomId" to "x", "ROOMID" to "x", "Version" to "x", "CharacterTextureIds" to "x", "token" to "x", "Token" to "x", "ok" to "1"),
        )
        val u = wsUrl(cfg, "t")
        assertEquals(listOf(Wa133.DEFAULT_ROOM), u.queryParameterValues("roomId"))
        assertEquals(null, u.queryParameter("ROOMID"))
        assertEquals(null, u.queryParameter("Version"))
        assertEquals(listOf(Wa133.DEFAULT_WOKA), u.queryParameterValues("characterTextureIds"))
        assertEquals(null, u.queryParameter("CharacterTextureIds"))
        assertEquals(null, u.queryParameter("token"))
        assertEquals(null, u.queryParameter("Token"))
        assertEquals("1", u.queryParameter("ok"))
    }

    @Test
    fun wsUrlHandshakeQuerySubstitutesPlaceholdersPerConnection() {
        val cfg = RoomConfig(name = "n", handshakeQuery = mapOf("a" to "t-{tabId}", "b" to "{uuid}", "c" to "{uuid}"))
        val u1 = wsUrl(cfg, "tab1")
        val u2 = wsUrl(cfg, "tab2")
        assertEquals("t-tab1", u1.queryParameter("a"))
        assertEquals("t-tab2", u2.queryParameter("a"))
        val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        assertTrue(uuid.matches(u1.queryParameter("b")!!))
        assertTrue(uuid.matches(u1.queryParameter("c")!!))
        assertNotEquals(u1.queryParameter("b"), u1.queryParameter("c"))
        assertNotEquals(u1.queryParameter("b"), u2.queryParameter("b"))
    }
}
