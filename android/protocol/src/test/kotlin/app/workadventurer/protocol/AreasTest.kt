package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class AreasTest {
    private val wam = """
      {"areas":[
        {"id":"a1","name":"Fire pit","x":100,"y":100,"width":200,"height":100,
         "properties":[{"type":"livekitRoomProperty","roomName":"pit"}]},
        {"id":"s1","name":"","x":1000,"y":1000,"width":64,"height":64,
         "properties":[{"type":"start"}]},
        {"id":"s2","name":"Main start","x":2000,"y":2000,"width":128,"height":128,
         "properties":[{"type":"start","isDefault":true}]}
      ]}"""

    @Test
    fun parseWamReadsBoundsNamesAndStartFlags() {
        val areas = parseWam(wam)
        assertEquals(3, areas.size)
        val pit = areas[0]
        assertEquals("Fire pit", pit.name)
        assertTrue(pit.contains(150, 150))
        assertTrue(!pit.contains(50, 150))
        assertEquals("(unnamed)", areas[1].name)
        assertTrue(areas[2].isStart && areas[2].isDefaultStart)
    }

    @Test
    fun pickSpawnPrefersDefaultStartAndStaysInsideWithMargin() {
        repeat(50) { i ->
            val s = pickSpawn(parseWam(wam), Random(i))
            assertEquals("Main start", s.area)
            assertTrue(s.x in 2012..2116 && s.y in 2012..2116, "spawn ${s.x},${s.y}")
        }
    }

    @Test
    fun pickSpawnFallsBackWhenNoStartArea() {
        assertEquals(Spawn(320, 320, null), pickSpawn(emptyList()))
        assertEquals(Spawn(320, 320, null), pickSpawn(parseWam("""{"areas":[]}""")))
    }

    @Test
    fun loadAreasSwallowsFetchFailures() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(500))
            server.start()
            val cfg = RoomConfig(pusherUrl = server.url("/").toString().trimEnd('/'), name = "t")
            assertEquals(emptyList(), loadAreas(OkHttpClient(), cfg))
        }
    }

    @Test
    fun loadAreasFollowsMapToWam() = runTest {
        MockWebServer().use { server ->
            server.start()
            val base = server.url("/").toString().trimEnd('/')
            server.enqueue(MockResponse().setBody("""{"wamUrl":"$base/the.wam"}"""))
            server.enqueue(MockResponse().setBody(wam))
            val areas = loadAreas(OkHttpClient(), RoomConfig(pusherUrl = base, name = "t"))
            assertEquals(3, areas.size)
            val first = server.takeRequest()
            assertNotNull(first.path)
            assertTrue(first.path!!.startsWith("/map?playUri="))
        }
    }
}
