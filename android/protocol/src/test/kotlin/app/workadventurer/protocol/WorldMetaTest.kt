package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WorldMetaTest {
    // The shape of a real prod .wam (campus, 2026-11-24): metadata sits beside areas and entities.
    private val wam = """
      {"version":"1.0.0","areas":[],"metadata":{
        "name":"campus",
        "description":"Suitable for up to 100 users.\n\nWith great power comes great university.",
        "copyright":"CC-BY-SA 3.0",
        "thumbnail":"https://workadventure.github.io/wam-preset-university/map.png"}}"""

    @Test
    fun readsNameDescriptionAndThumbnail() {
        val meta = parseWorldMeta(wam)
        assertEquals("campus", meta.name)
        assertEquals("Suitable for up to 100 users.\n\nWith great power comes great university.", meta.description)
        assertEquals("https://workadventure.github.io/wam-preset-university/map.png", meta.thumbnail)
    }

    @Test
    fun missingOrBlankFieldsAreNull() {
        assertEquals(WorldMeta(null, null, null), parseWorldMeta("""{"areas":[]}"""))
        assertEquals(WorldMeta(null, null, null), parseWorldMeta("""{"metadata":{"name":"  ","description":"","thumbnail":null}}"""))
    }

    @Test
    fun aThumbnailThatIsNotAnAbsoluteWebAddressIsDropped() {
        // The picture is fetched as given; a relative or odd scheme is not something we can load.
        assertNull(parseWorldMeta("""{"metadata":{"thumbnail":"map.png"}}""").thumbnail)
        assertNull(parseWorldMeta("""{"metadata":{"thumbnail":"file:///etc/passwd"}}""").thumbnail)
    }

    @Test
    fun anUnreadableWamGivesNothing() {
        assertEquals(WorldMeta(null, null, null), parseWorldMeta("not json"))
    }

    @Test
    fun fetchFollowsMapToWam() = runTest {
        MockWebServer().use { server ->
            server.start()
            val base = server.url("/").toString().trimEnd('/')
            server.enqueue(MockResponse().setBody("""{"wamUrl":"$base/the.wam"}"""))
            server.enqueue(MockResponse().setBody(wam))
            val meta = fetchWorldMeta(OkHttpClient(), RoomConfig(pusherUrl = base, name = "t"))
            assertEquals("campus", meta?.name)
        }
    }

    @Test
    fun fetchFailureIsNullNotAnError() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(500))
            server.start()
            val cfg = RoomConfig(pusherUrl = server.url("/").toString().trimEnd('/'), name = "t")
            assertNull(fetchWorldMeta(OkHttpClient(), cfg))
        }
    }
}
