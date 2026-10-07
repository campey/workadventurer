package app.workadventurer.protocol

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

// The campus map's furniture, blocked as fixed 3x3 squares, split the walkable space into 20 islands; the prefab collection
// files WorkAdventure publishes carry each prefab's real collision grid.
class EntityGridsTest {
    private val collection = """{"collectionName":"C","tags":[],"collection":[
        {"name":"Sofa","color":"#fff","direction":"Down","collisionGrid":[[0,0],[1,1]]},
        {"name":"Rug","color":"#000","direction":"Up"}]}"""
    private val tmj = """{"width":5,"height":4,"tilewidth":32,"tilesets":[],"layers":[]}"""

    private class Site(val server: MockWebServer, val hits: ConcurrentHashMap<String, AtomicInteger>) {
        val base get() = server.url("/").toString().trimEnd('/')
        fun wam(collections: String) =
            """{"mapUrl":"$base/the.tmj","entities":{"a":{"x":64,"y":32,"prefabRef":{"id":"C:Sofa:#fff:Down"}}},"areas":[],"entityCollections":$collections}"""
    }

    private fun site(routes: Map<String, String>): Site {
        val hits = ConcurrentHashMap<String, AtomicInteger>()
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                hits.getOrPut(request.path!!) { AtomicInteger() }.incrementAndGet()
                return routes[request.path]?.let { MockResponse().setBody(it) } ?: MockResponse().setResponseCode(404)
            }
        }
        s.start()
        return Site(s, hits)
    }

    private fun tempDir(): File = Files.createTempDirectory("entitygrids").toFile()

    @Test
    fun loadsEachPrefabsGridFromTheFileCollectionsAndSkipsOtherCollectionTypes() = runTest {
        val s = site(mapOf("/coll.json" to collection, "/skip.json" to collection))
        s.server.use {
            val grids = loadEntityGrids(OkHttpClient(), s.wam("""[{"url":"${s.base}/coll.json","type":"file"},{"url":"${s.base}/skip.json","type":"map-storage"}]"""))
            assertEquals(mapOf("C:Sofa:#fff:Down" to listOf(listOf(0, 0), listOf(1, 1)), "C:Rug:#000:Up" to null), grids)
            assertNull(s.hits["/skip.json"], "only `file` collections are fetched")
        }
    }

    @Test
    fun aCollectionThatFailsOrIsNotJsonIsSkippedAndNothingLoadedGivesNull() = runTest {
        val s = site(mapOf("/bad.json" to "<html>502</html>", "/coll.json" to collection))
        s.server.use {
            val both = loadEntityGrids(OkHttpClient(), s.wam("""[{"url":"${s.base}/bad.json","type":"file"},{"url":"${s.base}/gone.json","type":"file"},{"url":"${s.base}/coll.json","type":"file"}]"""))
            assertEquals(setOf("C:Sofa:#fff:Down", "C:Rug:#000:Up"), both!!.keys)
            val none = loadEntityGrids(OkHttpClient(), s.wam("""[{"url":"${s.base}/bad.json","type":"file"},{"url":"${s.base}/gone.json","type":"file"}]"""))
            assertNull(none, "no collection loaded: the caller keeps the old furniture approximation")
            assertNull(loadEntityGrids(OkHttpClient(), """{"entities":{}}"""))
            assertNull(loadEntityGrids(OkHttpClient(), "{{{ nope"))
        }
    }

    @Test
    fun aSecondCallWithinTheTtlUsesTheDiskCache() = runTest {
        val dir = tempDir()
        val s = site(mapOf("/coll.json" to collection))
        try {
            s.server.use {
                val wam = s.wam("""[{"url":"${s.base}/coll.json","type":"file"}]""")
                assertNotNull(loadEntityGrids(OkHttpClient(), wam, dir))
                assertNotNull(loadEntityGrids(OkHttpClient(), wam, dir))
                assertEquals(1, s.hits["/coll.json"]!!.get(), "the second call must not hit the network")
            }
        } finally { dir.deleteRecursively() }
    }

    @Test
    fun theNavGridBlocksExactlyThePrefabsSolidCellsInsteadOfA3x3() = runTest {
        val s = site(mapOf("/the.tmj" to tmj, "/coll.json" to collection))
        s.server.use {
            val g = loadNavGrid(OkHttpClient(), s.wam("""[{"url":"${s.base}/coll.json","type":"file"}]"""))!!
            assertEquals(listOf(12, 13), g.blockedIndices().toList()) // (2,2) and (3,2) on the 5-wide map; not the 9-tile block
        }
    }

    @Test
    fun withNoUsableCollectionsTheNavGridKeepsTheOldApproximation() = runTest {
        val s = site(mapOf("/the.tmj" to tmj))
        s.server.use {
            val g = loadNavGrid(OkHttpClient(), s.wam("""[{"url":"${s.base}/gone.json","type":"file"}]"""))!!
            assertEquals(9, g.blockedIndices().toList().size)
        }
    }
}
