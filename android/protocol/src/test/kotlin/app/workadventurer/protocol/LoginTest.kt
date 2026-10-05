package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

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
        val u = wsUrl(RoomConfig(name = "n", apiVersionHash = "23c8eb8c"), tabId = "t")
        assertEquals("23c8eb8c", u.queryParameter("version"))
    }

    @Test
    fun wsUrlCarriesRoomWokaVersionAndMediaState() {
        val cfg = RoomConfig(name = "n", micOn = false)
        val u = wsUrl(cfg, tabId = "abc123abc123")
        assertEquals("/ws/room", u.encodedPath)
        assertEquals(Wa133.DEFAULT_ROOM, u.queryParameter("roomId"))
        assertEquals(listOf(Wa133.DEFAULT_WOKA), u.queryParameterValues("characterTextureIds"))
        assertEquals("23c8eb8c", u.queryParameter("version")) // prod v1.34.0 (live-verified; see field-notes)
        assertEquals("false", u.queryParameter("microphoneState"))
        assertEquals("false", u.queryParameter("cameraState"))
        assertEquals("abc123abc123", u.queryParameter("tabId"))
        assertEquals("pusher.workadventu.re", u.host)
    }
}
