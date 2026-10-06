package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class NavGridLoaderTest {
    private val tmj = """{"width":4,"height":3,"tilewidth":32,"tilesets":[],"layers":[
        {"type":"tilelayer","name":"collisions","data":[0,1,0,0, 0,0,0,0, 0,0,0,1]}]}"""

    private class Site(val server: MockWebServer, val tmjRequests: AtomicInteger) {
        @Volatile var tmjOk = true
        @Volatile var body: String? = null // replaces the served map when set
        val base get() = server.url("/").toString().trimEnd('/')
        fun wam(withMapUrl: Boolean = true) =
            if (withMapUrl) """{"mapUrl":"$base/the.tmj","entities":{},"areas":[]}""" else """{"entities":{}}"""
    }

    private fun site(tmj: String): Site {
        val server = MockWebServer()
        val count = AtomicInteger()
        lateinit var site: Site
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/the.tmj" -> {
                    count.incrementAndGet()
                    if (site.tmjOk) MockResponse().setBody(site.body ?: tmj) else MockResponse().setResponseCode(500)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        site = Site(server, count)
        return site
    }

    private fun tempDir(): File = Files.createTempDirectory("navcache").toFile()

    @Test
    fun buildsAGridFromTheWamsMapUrl() = runTest {
        val s = site(tmj)
        s.server.use {
            val g = loadNavGrid(OkHttpClient(), s.wam())!!
            assertEquals(listOf(1, 11), g.blockedIndices().toList())
            assertEquals(4, g.w); assertEquals(3, g.h)
        }
    }

    @Test
    fun noMapUrlGivesNull() = runTest {
        val s = site(tmj)
        s.server.use { assertNull(loadNavGrid(OkHttpClient(), s.wam(withMapUrl = false))) }
    }

    @Test
    fun aFailedDownloadWithoutACacheGivesNull() = runTest {
        val s = site(tmj)
        s.tmjOk = false
        s.server.use { assertNull(loadNavGrid(OkHttpClient(), s.wam())) }
    }

    @Test
    fun aGarbledWamGivesNullInsteadOfThrowing() = runTest {
        assertNull(loadNavGrid(OkHttpClient(), "{{{ not json"))
    }

    @Test
    fun aSecondCallWithinTheTtlUsesTheDiskCache() = runTest {
        val dir = tempDir()
        val s = site(tmj)
        try {
            s.server.use {
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                assertEquals(1, s.tmjRequests.get(), "second call must not hit the network")
            }
        } finally { dir.deleteRecursively() }
    }

    @Test
    fun anExpiredCacheIsRefetched() = runTest {
        val dir = tempDir()
        val s = site(tmj)
        try {
            s.server.use {
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                val later = { System.currentTimeMillis() + 25L * 3_600_000 }
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir, nowMs = later))
                assertEquals(2, s.tmjRequests.get())
            }
        } finally { dir.deleteRecursively() }
    }

    @Test
    fun aStaleCacheBeatsNothingWhenTheRefetchFails() = runTest {
        val dir = tempDir()
        val s = site(tmj)
        try {
            s.server.use {
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                s.tmjOk = false
                val later = { System.currentTimeMillis() + 25L * 3_600_000 }
                val g = loadNavGrid(OkHttpClient(), s.wam(), dir, nowMs = later)
                assertNotNull(g, "should fall back to the stale cache")
                assertEquals(2, s.tmjRequests.get())
            }
        } finally { dir.deleteRecursively() }
    }

    // A 200 whose body isn't a usable map (an HTML error page, a truncated download) must not be cached: it would be
    // served as "no grid" for 24 h even after the server recovered.
    @Test
    fun aSuccessfulResponseThatIsNotAMapIsNotCached() = runTest {
        val dir = tempDir()
        val s = site(tmj)
        s.body = "<html>502 bad gateway</html>"
        try {
            s.server.use {
                assertNull(loadNavGrid(OkHttpClient(), s.wam(), dir))
                s.body = null // the server recovers
                assertNotNull(loadNavGrid(OkHttpClient(), s.wam(), dir), "the bad body was cached and served again")
                assertEquals(2, s.tmjRequests.get())
            }
        } finally { dir.deleteRecursively() }
    }
}
