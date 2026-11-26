package app.workadventurer.protocol.catalog

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlin.coroutines.coroutineContext
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RecoverAdapterTest {
    private val H = "abcd1234"
    private val server = MockWebServer()
    private val routes = HashMap<String, () -> MockResponse>()
    private val hits = ArrayList<String>()
    private lateinit var dir: File
    private lateinit var store: FileAdapterStore
    private val client = OkHttpClient()
    private lateinit var roomUrl: String
    private lateinit var indexUrl: String

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun adapter(
        hash: String = H, query: String = """{"Foo":"bar","T":"{tabId}","U":"{uuid}"}""", schema: String = "1", extra: String = "",
    ) = """{"schema":$schema,"id":"wa-x","waVersion":"1.40.0","apiVersionHash":"$hash","server":"production","protoFamily":"wa-9.99",""" +
        """"meeting":"ignored","handshake":{"query":$query}$extra}"""

    private fun home(hash: String? = H) = """<html><head>${if (hash != null) """<meta name="wa-api-version" content="$hash">""" else ""}</head><body>v1.40.0</body></html>"""

    private fun index(entries: String) = """{"schema":1,"entries":{$entries}}"""
    private fun okEntry(file: String = "adapters/$H.json", sha256: String) = """"$H":{"status":"ok","file":"$file","sha256":"$sha256"}"""

    private fun serve(path: String, body: String, code: Int = 200) = serve(path, body.toByteArray()) { it.setResponseCode(code) }
    private fun serve(path: String, body: ByteArray, cfg: (MockResponse) -> Unit = {}) {
        routes[path] = { MockResponse().setBody(Buffer().write(body)).also(cfg) }
    }

    /** Serve a normal server + index + file; returns the file bytes. */
    private fun happy(fileJson: String = adapter(), entriesBuilder: (String) -> String = { okEntry(sha256 = it) }): ByteArray {
        val bytes = fileJson.toByteArray()
        serve("/", home())
        serve("/catalog/index.json", index(entriesBuilder(sha(bytes))))
        serve("/catalog/adapters/$H.json", bytes) {}
        return bytes
    }

    @BeforeTest fun up() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                hits += request.path!!
                return routes[request.path]?.invoke() ?: MockResponse().setResponseCode(404)
            }
        }
        server.start()
        roomUrl = server.url("/@/o/w/room").toString()
        indexUrl = server.url("/catalog/index.json").toString()
        dir = Files.createTempDirectory("adapters").toFile()
        store = FileAdapterStore(dir)
    }

    @AfterTest fun down() { server.shutdown(); dir.deleteRecursively() }

    private fun recover(
        mode: AdapterUpdates = AdapterUpdates.AUTO,
        ask: suspend (AdapterOffer) -> AdapterAnswer = { error("ask must not be called") },
        onAlways: () -> Unit = {},
        builtins: Set<String> = setOf("11111111"),
        timeoutMs: Long = 3000,
    ) = runBlocking { recoverAdapter(roomUrl, mode, ask, onAlways, builtins, store, client, indexUrl, timeoutMs) }

    private fun assertUnavailable(o: RecoverOutcome) = assertIs<RecoverOutcome.Unavailable>(o)

    // ---- outcomes

    @Test fun appliedAutoDownloadsVerifiesCachesAndReturnsTheQuery() {
        happy()
        val o = recover()
        assertEquals(RecoverOutcome.Applied(H, mapOf("Foo" to "bar", "T" to "{tabId}", "U" to "{uuid}"), "1.40.0"), o)
        assertNotNull(store.load(H))
    }

    @Test fun anAdapterWithNoHandshakeAppliesWithAnEmptyQuery() {
        happy("""{"schema":1,"id":"a","waVersion":"1","apiVersionHash":"$H","server":"staging","protoFamily":"whatever","movement":5}""")
        assertEquals(RecoverOutcome.Applied(H, emptyMap(), "1"), recover())
    }

    @Test fun builtinHashIsKnownAndNothingElseIsFetched() {
        happy()
        assertEquals(RecoverOutcome.Known(H), recover(builtins = setOf(H)))
        assertEquals(listOf("/"), hits)
    }

    @Test fun aLoadableCachedFileIsKnownWithItsQueryAndAvoidsTheIndex() {
        happy(); recover()
        hits.clear()
        val o = recover()
        assertEquals(RecoverOutcome.Known(H, mapOf("Foo" to "bar", "T" to "{tabId}", "U" to "{uuid}"), fromCache = true), o)
        assertEquals(listOf("/"), hits)
    }

    @Test fun aCorruptCacheIsIgnoredAndOverwritten() {
        happy()
        File(dir, "$H.json").writeText("{not json")
        assertIs<RecoverOutcome.Applied>(recover())
        assertNotNull(store.load(H))
    }

    @Test fun aCacheFileFiledUnderTheWrongHashIsIgnored() {
        File(dir, "$H.json").writeText(adapter(hash = "deadbeef"))
        assertNull(store.load(H))
    }

    @Test fun noEntry() {
        serve("/", home()); serve("/catalog/index.json", index(""""deadbeef":{"status":"ok","file":"a.json","sha256":"${"0".repeat(64)}"}"""))
        assertEquals(RecoverOutcome.NoEntry(H), recover())
    }

    @Test fun needsAttentionWithSanitisedAndCappedGate() {
        val gate = "line1\nline2\u0007\u0085" + "x".repeat(300)
        serve("/", home())
        serve("/catalog/index.json", index(""""$H":{"status":"needs-attention","gate":"${gate.replace("\n", "\\n").replace("\u0007", "\\u0007")}","file":"x.json","sha256":"${"0".repeat(64)}"}"""))
        val o = assertIs<RecoverOutcome.NeedsAttention>(recover())
        val d = o.detail!!
        assertTrue(d.startsWith("line1 line2  xxx"), d)
        assertTrue(d.none { it.code < 0x20 || it.code in 0x7f..0x9f })
        assertEquals(201, d.length); assertTrue(d.endsWith("…"))
        assertFalse(hits.any { it.endsWith("/x.json") })
    }

    @Test fun needsAttentionWithObjectGateAndNoGate() {
        serve("/", home())
        serve("/catalog/index.json", index(""""$H":{"status":"needs-attention","gate":{"a":1}}"""))
        assertEquals("""{"a":1}""", (recover() as RecoverOutcome.NeedsAttention).detail)
        serve("/catalog/index.json", index(""""$H":{"status":"needs-attention"}"""))
        assertNull((recover() as RecoverOutcome.NeedsAttention).detail)
    }

    @Test fun neverModeDownloadsNothing() {
        happy()
        assertEquals(RecoverOutcome.Never(H), recover(mode = AdapterUpdates.NEVER))
        assertFalse(hits.any { it.contains("adapters") })
    }

    @Test fun neverModeStillReportsNoEntryAndNeedsAttention() {
        serve("/", home()); serve("/catalog/index.json", index(""))
        assertEquals(RecoverOutcome.NoEntry(H), recover(mode = AdapterUpdates.NEVER))
    }

    @Test fun askYesApplies() {
        happy()
        var offer: AdapterOffer? = null
        val o = recover(AdapterUpdates.ASK, ask = { offer = it; AdapterAnswer.YES })
        assertIs<RecoverOutcome.Applied>(o)
        // MockWebServer is http, so the https-only adapterUrl is withheld; the date is absent from this index.
        assertEquals(AdapterOffer(H, "v1.40.0"), offer)
    }

    @Test fun askReceivesTheCatalogDateAndAnHttpsAdapterUrlOnly() {
        val bytes = happy()
        serve("/catalog/index.json", """{"schema":1,"updated":"2026-11-21T14:05:09Z","entries":{${okEntry(sha256 = sha(bytes))}}}""")
        var offer: AdapterOffer? = null
        recover(AdapterUpdates.ASK, ask = { offer = it; AdapterAnswer.NO })
        assertEquals("2026-11-21T14:05:09Z", offer!!.catalogUpdated)
        assertNull(offer!!.adapterUrl) // http origin: not offered for display
    }

    @Test fun aMalformedUpdatedIsIgnored() {
        val bytes = happy()
        serve("/catalog/index.json", """{"schema":1,"updated":"last tuesday","entries":{${okEntry(sha256 = sha(bytes))}}}""")
        var offer: AdapterOffer? = null
        recover(AdapterUpdates.ASK, ask = { offer = it; AdapterAnswer.NO })
        assertNull(offer!!.catalogUpdated)
    }

    @Test fun displayAdapterUrlIsHttpsAndValidatedOnly() {
        val e = IndexEntry.Ok("adapters/$H.json", "0".repeat(64))
        val idx = "https://raw.example.com/o/r/main/catalog/index.json"
        assertEquals("https://raw.example.com/o/r/main/catalog/adapters/$H.json", CatalogClient.displayAdapterUrl(idx, e))
        assertNull(CatalogClient.displayAdapterUrl("http://raw.example.com/catalog/index.json", e))
        assertNull(CatalogClient.displayAdapterUrl(idx, IndexEntry.Ok("https://evil.example.org/x.json", "0".repeat(64))))
        assertNull(CatalogClient.displayAdapterUrl(idx, IndexEntry.Ok("../x.json", "0".repeat(64))))
    }

    @Test fun askNoIsDeclinedAndDownloadsNothing() {
        happy()
        assertEquals(RecoverOutcome.Declined(H), recover(AdapterUpdates.ASK, ask = { AdapterAnswer.NO }))
        assertFalse(hits.any { it.contains("adapters") })
        assertNull(store.load(H))
    }

    @Test fun askThrowingFailsClosed() {
        happy()
        assertEquals(RecoverOutcome.Declined(H), recover(AdapterUpdates.ASK, ask = { throw IllegalStateException("boom") }))
        assertFalse(hits.any { it.contains("adapters") })
    }

    @Test fun alwaysCallsOnAlwaysExactlyOnceAndApplies() {
        happy()
        var n = 0
        assertIs<RecoverOutcome.Applied>(recover(AdapterUpdates.ASK, ask = { AdapterAnswer.ALWAYS }, onAlways = { n++ }))
        assertEquals(1, n)
    }

    @Test fun anOnAlwaysThatThrowsStillApplies() {
        happy()
        assertIs<RecoverOutcome.Applied>(recover(AdapterUpdates.ASK, ask = { AdapterAnswer.ALWAYS }, onAlways = { error("no disk") }))
    }

    @Test fun autoNeverAsksAndDoesNotCallOnAlways() {
        happy()
        assertIs<RecoverOutcome.Applied>(recover(AdapterUpdates.AUTO, onAlways = { error("no") }))
    }

    // ---- unavailable: page / index

    @Test fun pageFailuresAreUnavailableAndAMissingOrBadTagIsUnreadable() {
        assertUnavailable(recover())                                   // 404 home
        serve("/", home(hash = null)); assertEquals(RecoverOutcome.VersionUnreadable, recover()) // no meta
        serve("/", home(hash = "XYZ12345")); assertEquals(RecoverOutcome.VersionUnreadable, recover())
    }

    @Test fun anIndex404IsUnavailable() { serve("/", home()); assertUnavailable(recover()) }

    @Test fun indexTimeoutIsUnavailableAndDoesNotHang() {
        serve("/", home())
        routes["/catalog/index.json"] = { MockResponse().setBody("{}").setBodyDelay(5, java.util.concurrent.TimeUnit.SECONDS) }
        val t0 = System.currentTimeMillis()
        assertUnavailable(recover(timeoutMs = 300))
        assertTrue(System.currentTimeMillis() - t0 < 3000)
    }

    @Test fun anIndexRedirectIsAFailureAndNotFollowed() {
        serve("/", home())
        routes["/catalog/index.json"] = { MockResponse().setResponseCode(302).setHeader("Location", "/catalog/other.json") }
        serve("/catalog/other.json", index(okEntry(sha256 = "0".repeat(64))))
        assertUnavailable(recover())
        assertFalse(hits.contains("/catalog/other.json"))
    }

    @Test fun anOversizeIndexIsUnavailable() {
        serve("/", home())
        serve("/catalog/index.json", ByteArray(1024 * 1024 + 10) { ' '.code.toByte() })
        assertUnavailable(recover())
    }

    @Test fun anOversizeChunkedIndexIsCutAndUnavailable() {
        serve("/", home())
        routes["/catalog/index.json"] = { MockResponse().setChunkedBody("x".repeat(1024 * 1024 + 10), 8192) }
        assertUnavailable(recover())
    }

    @Test fun badIndexesAreUnavailable() {
        serve("/", home())
        for (body in listOf("not json", """{"schema":2,"entries":{}}""", """{"schema":1,"entries":[]}""", "[]", """{"schema":"1","entries":{}}""")) {
            serve("/catalog/index.json", body)
            assertUnavailable(recover())
        }
    }

    @Test fun anIndexWithAUtf8BomParses() {
        happy()
        val bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + index(okEntry(sha256 = sha(adapter().toByteArray()))).toByteArray()
        serve("/catalog/index.json", bytes)
        assertIs<RecoverOutcome.Applied>(recover())
    }

    @Test fun anAdapterFileWithABomHashesRawAndParses() {
        val bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + adapter().toByteArray()
        serve("/", home()); serve("/catalog/index.json", index(okEntry(sha256 = sha(bytes)))); serve("/catalog/adapters/$H.json", bytes)
        assertIs<RecoverOutcome.Applied>(recover())
        assertNotNull(store.load(H)) // the cache keeps the raw bytes, BOM included, and still loads
    }

    // ---- unavailable: file

    private fun assertFileFails(vararg needle: String) {
        val o = assertIs<RecoverOutcome.Unavailable>(recover())
        for (n in needle) assertTrue(o.reason.contains(n), o.reason)
        assertNull(store.load(H))
    }

    @Test fun file404() { happy(); routes.remove("/catalog/adapters/$H.json"); assertFileFails("404") }

    @Test fun fileRedirect() {
        happy()
        routes["/catalog/adapters/$H.json"] = { MockResponse().setResponseCode(301).setHeader("Location", "/catalog/x.json") }
        assertFileFails("redirect")
    }

    @Test fun fileTimeout() {
        happy()
        routes["/catalog/adapters/$H.json"] = { MockResponse().setBody("{}").setBodyDelay(5, java.util.concurrent.TimeUnit.SECONDS) }
        val o = assertIs<RecoverOutcome.Unavailable>(recover(timeoutMs = 300))
        assertTrue(o.reason.contains("timed out"), o.reason)
    }

    @Test fun oversizeFile() {
        val big = adapter(extra = ""","pad":"${"x".repeat(70 * 1024)}"""")
        happy(big); assertFileFails("too large")
    }

    @Test fun badSha256() {
        happy(entriesBuilder = { okEntry(sha256 = "f".repeat(64)) }); assertFileFails("sha256")
    }

    @Test fun malformedShaEntryIsDroppedSoNoEntry() {
        happy(entriesBuilder = { okEntry(sha256 = "ABC") })
        assertEquals(RecoverOutcome.NoEntry(H), recover())
    }

    @Test fun fileHashMismatch() { happy(adapter(hash = "deadbeef")); assertFileFails("apiVersionHash") }

    @Test fun wrongSchema() { happy(adapter(schema = "2")); assertFileFails("schema") }

    @Test fun wrongTypes() {
        happy(adapter().replace(""""id":"wa-x"""", """"id":5""")); assertFileFails("id")
    }

    @Test fun notJsonFile() { happy("nope"); assertFileFails("must be an object") }

    @Test fun crossOriginFile() {
        happy(entriesBuilder = { okEntry(file = "http://127.0.0.1:1/catalog/adapters/$H.json", sha256 = it) })
        assertFileFails("origin")
        happy(entriesBuilder = { okEntry(file = "//evil.example/catalog/adapters/$H.json", sha256 = it) })
        assertFileFails("origin")
    }

    @Test fun fileOutsideTheIndexDirectory() {
        happy(entriesBuilder = { okEntry(file = "../secret/$H.json", sha256 = it) }); assertFileFails("outside")
        happy(entriesBuilder = { okEntry(file = "/elsewhere/$H.json", sha256 = it) }); assertFileFails("outside")
        happy(entriesBuilder = { okEntry(file = "adapters/../../up/$H.json", sha256 = it) }); assertFileFails("outside")
    }

    // ---- handshake validation

    private fun queryFails(query: String, needle: String) { happy(adapter(query = query)); assertFileFails(needle) }

    @Test fun badHandshakeNames() {
        queryFails("""{"1bad":"x"}""", "invalid")
        queryFails("""{"has space":"x"}""", "invalid")
        queryFails("""{"${"a".repeat(33)}":"x"}""", "invalid")
        queryFails("""{"":"x"}""", "invalid")
    }

    @Test fun badHandshakeValues() {
        queryFails("""{"A":"${"v".repeat(65)}"}""", "value is invalid")
        queryFails("""{"A":"a b"}""", "value is invalid")
        queryFails("""{"A":"a&b=c"}""", "value is invalid")
        queryFails("""{"A":5}""", "value is invalid")
        queryFails("""{"A":"{other}"}""", "placeholder")
        queryFails("""{"A":"{tabId"}""", "placeholder")
        queryFails("""{"A":"{}"}""", "placeholder")
    }

    @Test fun forbiddenNamesCaseInsensitive() {
        for (n in listOf("roomId", "ROOMID", "Version", "characterTextureIds", "Token")) queryFails("""{"$n":"x"}""", "forbidden")
    }

    @Test fun tooManyParams() {
        val twelve = (1..12).joinToString(",") { """"p$it":"v"""" }
        happy(adapter(query = "{$twelve}")); assertIs<RecoverOutcome.Applied>(recover())
    }

    @Test fun thirteenParamsIsTooMany() {
        val twelve = (1..12).joinToString(",") { """"p$it":"v"""" }
        queryFails("{$twelve,\"p13\":\"v\"}", "more than 12")
    }

    @Test fun handshakeQueryMustBeAnObject() { queryFails("[]", "object"); queryFails("\"x\"", "object") }

    @Test fun maximumLengthValuesAndNamesAreAccepted() {
        happy(adapter(query = """{"${"a".repeat(32)}":"${"v".repeat(64)}"}""")); assertIs<RecoverOutcome.Applied>(recover())
    }

    // ---- store and helpers

    @Test fun storeLoadNeverThrowsOnGarbage() {
        File(dir, "$H.json").writeBytes(byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0x00))
        assertNull(store.load(H))
        assertNull(store.load("../../etc"))
        assertNull(FileAdapterStore(File(dir, "missing/sub")).load(H))
    }

    @Test fun storeSaveIsAtomicAndLeavesNoTempFiles() {
        store.save(H, adapter()); store.save(H, adapter())
        assertEquals(listOf("$H.json"), dir.list()!!.toList())
    }

    @Test fun serverVersionReadsHashAndRelease() {
        serve("/", home())
        val v = runBlocking { ServerVersionReader.read(client, roomUrl) }
        assertEquals(ServerVersion(H, "v1.40.0"), v)
        serve("/", """<meta content="$H" name='wa-api-version'><p>master@118dd84c""")
        assertEquals(ServerVersion(H, "master@118dd84c"), runBlocking { ServerVersionReader.read(client, roomUrl) })
    }

    // ---- review fixes

    @Test fun cancellingMidPageReadStopsTheCallAndCachesNothing() {
        happy()
        routes["/"] = { MockResponse().setBody(home()).setBodyDelay(3, java.util.concurrent.TimeUnit.SECONDS) }
        runBlocking {
            val job = launch(Dispatchers.Default) {
                recoverAdapter(roomUrl, AdapterUpdates.AUTO, { error("no") }, {}, emptySet(), store, client, indexUrl, 10_000)
            }
            delay(400)
            val t0 = System.currentTimeMillis()
            job.cancelAndJoin()
            assertTrue(System.currentTimeMillis() - t0 < 2000)
        }
        Thread.sleep(300)
        assertEquals(listOf("/"), hits)
        assertEquals(0, dir.list()!!.size)
    }

    @Test fun cancellingDuringConsentNeverDownloadsOrCaches() {
        happy()
        runBlocking {
            val job = launch {
                recoverAdapter(roomUrl, AdapterUpdates.ASK, { coroutineContext.job.cancel(); AdapterAnswer.YES }, {}, emptySet(), store, client, indexUrl, 3000)
            }
            job.join()
        }
        assertFalse(hits.any { it.contains("adapters") })
        assertEquals(0, dir.list()!!.size)
    }

    @Test fun anAskThrowingItsOwnCancellationWhileActiveIsDeclined() {
        happy()
        assertEquals(RecoverOutcome.Declined(H), recover(AdapterUpdates.ASK, ask = { throw CancellationException("ask timeout") }))
        assertFalse(hits.any { it.contains("adapters") })
    }

    @Test fun hostileMetaPageIsLinearAndANormalOneStillParses() {
        serve("/", "<meta ".repeat(85_000))
        var t0 = System.currentTimeMillis()
        assertNull(runBlocking { ServerVersionReader.read(client, roomUrl) })
        assertTrue(System.currentTimeMillis() - t0 < 2000)
        serve("/", "<meta ".repeat(40_000) + "x>" + home())
        t0 = System.currentTimeMillis()
        assertEquals(H, runBlocking { ServerVersionReader.read(client, roomUrl) }?.hash)
        assertTrue(System.currentTimeMillis() - t0 < 2000)
        assertEquals(H, ServerVersionReader.matchApiHash("<metadata name=\"wa-api-version\" content=\"00000000\"><meta name=\"wa-api-version\" content=\"$H\">"))
    }

    @Test fun theHomePageIsCappedAt512KiB() {
        serve("/", " ".repeat(512 * 1024 + 100) + home())
        assertEquals(RecoverOutcome.VersionUnreadable, recover())
        serve("/", home() + " ".repeat(600 * 1024))
        happy().also { serve("/", home() + " ".repeat(600 * 1024)) }
        assertIs<RecoverOutcome.Applied>(recover())
    }

    @Test fun aHomePageRedirectIsRefusedWithAClearReason() {
        routes["/"] = { MockResponse().setResponseCode(301).setHeader("Location", "/elsewhere") }
        serve("/elsewhere", home())
        val o = assertIs<RecoverOutcome.Unavailable>(recover())
        assertEquals("page: unexpected redirect (HTTP 301)", o.reason)
        assertFalse(hits.contains("/elsewhere"))
    }

    @Test fun unavailableReasonsAreSanitised() {
        serve("/", home())
        routes["/catalog/index.json"] = { MockResponse().setResponseCode(500).setStatus("HTTP/1.1 500 bad") }
        val o = assertIs<RecoverOutcome.Unavailable>(recover())
        assertTrue(o.reason.none { it.code < 0x20 })
        assertEquals("a b c d e", sanitizeText("a\u202Eb\u2028c\u200Bd\u0007e"))
        assertEquals(201, sanitizeText("y".repeat(500)).length)
    }

    @Test fun gateTextStripsBidiAndSeparators() {
        serve("/", home())
        serve("/catalog/index.json", index(""""$H":{"status":"needs-attention","gate":"ab\u202Ec\u2028d\u200Be\u2029f"}"""))
        assertEquals("ab c d e f", (recover() as RecoverOutcome.NeedsAttention).detail)
    }

    @Test fun schemaMustBeExactlyTheNumberOne() {
        for (s in listOf("1.0", "1e0", "\"1\"", "true", "0x1", "1d", "10", "null")) {
            happy(adapter(schema = s)); assertFileFails("schema")
            routes.clear()
        }
        serve("/", home()); serve("/catalog/index.json", index("").replace("\"schema\":1", "\"schema\":1.0"))
        assertUnavailable(recover())
    }

    @Test fun filePathsAreWhitelisted() {
        for (f in listOf("adapters/%2e%2e/$H.json", "adapters%2F$H.json", "adapters%5C$H.json", "adapters\\$H.json",
            "adapters/$H.json?x=1", "adapters/$H.json#f", "http://u:p@127.0.0.1:${server.port}/catalog/adapters/$H.json", "./adapters/$H.json", "adapters//$H.json")) {
            happy(entriesBuilder = { okEntry(file = f.replace("\\", "\\\\"), sha256 = it) })
            assertFileFails()
            routes.clear(); hits.clear()
        }
    }

    @Test fun duplicateKeysDoNotCrash() {
        happy("""{"schema":1,"id":"a","waVersion":"1","apiVersionHash":"$H","server":"staging","protoFamily":"p","handshake":{"query":{"A":"x","A":"y"}}}""")
        val o = recover()
        assertTrue(o is RecoverOutcome.Applied || o is RecoverOutcome.Unavailable)
    }

    @Test fun oversizeCacheFileIsIgnored() {
        File(dir, "$H.json").writeText(adapter(extra = ""","pad":"${"x".repeat(70 * 1024)}""""))
        assertNull(store.load(H))
    }

    @Test fun aProtoFamilyThatIsNotAStringIsRejected() {
        happy(adapter().replace(""""protoFamily":"wa-9.99"""", """"protoFamily":3""")); assertFileFails("protoFamily")
    }

    // ---- follow-ups

    @Test fun aPageWithoutTheVersionTagIsNotACatalogFailure() {
        serve("/", home(hash = null).replace("v1.40.0", "no version here"))
        assertEquals(RecoverOutcome.VersionUnreadable, recover())
        assertEquals(listOf("/"), hits) // the catalog is never asked
        serve("/", home(hash = null)) // a release string alone does not help: the hash is what the catalog is keyed on
        assertEquals(RecoverOutcome.VersionUnreadable, recover())
        routes["/"] = { MockResponse().setResponseCode(500) }
        assertEquals("page: HTTP 500", assertIs<RecoverOutcome.Unavailable>(recover()).reason)
    }

    @Test fun aCachedFileIsKnownFromCacheAndABuiltinIsNot() {
        store.save(H, adapter())
        serve("/", home())
        assertEquals(RecoverOutcome.Known(H, mapOf("Foo" to "bar", "T" to "{tabId}", "U" to "{uuid}"), fromCache = true), recover())
        assertEquals(RecoverOutcome.Known(H, emptyMap(), fromCache = false), recover(builtins = setOf(H)))
    }

    @Test fun theStoreDeletesAFileAndToleratesAMissingOneOrABadHash() {
        store.save(H, adapter())
        assertNotNull(store.load(H))
        store.delete(H)
        assertNull(store.load(H))
        assertEquals(0, dir.list()!!.size)
        store.delete(H) // already gone
        store.delete("../../etc/passwd") // not a hash: ignored
    }

    @Test fun anEntrysAddedInstantIsOfferedAndOnlyIfItParses() {
        for ((added, expected) in listOf(
            """"added":"2026-11-13T12:40:05.000Z"""" to "2026-11-13T12:40:05.000Z", """"added":"yesterday"""" to null,
            """"added":5""" to null, """"added":null""" to null, """"x":1""" to null,
        )) {
            val bytes = adapter().toByteArray()
            serve("/", home())
            serve("/catalog/index.json", index(""""$H":{"status":"ok","file":"adapters/$H.json","sha256":"${sha(bytes)}",$added}"""))
            var offered: AdapterOffer? = null
            recover(AdapterUpdates.ASK, ask = { offered = it; AdapterAnswer.NO })
            assertEquals(expected, offered?.adapterAdded, added)
        }
    }

    @Test fun nonOverlappingScanSkipsPastACandidateTag() {
        // One tag runs to its '>' (like the CLI's regex): a "<meta" inside it is not a new tag, so its first content= is the one read.
        assertNull(ServerVersionReader.matchApiHash("""<meta content='1' <meta name="wa-api-version" content='$H'>"""))
        assertEquals(H, ServerVersionReader.matchApiHash("""<meta x="1"><meta name='wa-api-version' content='$H'>"""))
    }

    /** A server that accepts the connection, reads the request and never answers; [closed] counts down when the client hangs up. */
    private class SilentServer : AutoCloseable {
        val socket = java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())
        val accepted = java.util.concurrent.CountDownLatch(1)
        val closed = java.util.concurrent.CountDownLatch(1)
        private val t = Thread {
            try {
                socket.accept().use { s ->
                    accepted.countDown()
                    val input = s.getInputStream()
                    val buf = ByteArray(4096)
                    var sawRequest = false
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        sawRequest = true
                    }
                    if (sawRequest) closed.countDown()
                }
            } catch (e: Exception) { /* closed under us */ }
        }.also { it.isDaemon = true; it.start() }
        override fun close() { socket.close() }
    }

    @Test fun cancellingReallyCancelsTheCallSoTheServerSeesTheHangUp() {
        SilentServer().use { silent ->
            val url = "http://127.0.0.1:${silent.socket.localPort}/@/o/w/r"
            runBlocking {
                // A 30 s timeout: only a real call.cancel() can end the exchange within the assertion window.
                val job = launch(Dispatchers.Default) { recoverAdapter(url, AdapterUpdates.AUTO, { error("no") }, {}, emptySet(), store, client, indexUrl, 30_000) }
                assertTrue(silent.accepted.await(5, java.util.concurrent.TimeUnit.SECONDS))
                delay(200)
                job.cancelAndJoin()
            }
            assertTrue(silent.closed.await(3, java.util.concurrent.TimeUnit.SECONDS), "the server must see the client hang up")
        }
    }

    @Test fun nonBmpFormatCharactersBecomeOneSpaceEach() {
        // U+E0001 LANGUAGE TAG and U+1D173 MUSICAL SYMBOL BEGIN BEAM are format characters outside the BMP; U+1F600 is a normal emoji.
        assertEquals("a b c \uD83D\uDE00", sanitizeText("a\uDB40\uDC01b\uD834\uDD73c \uD83D\uDE00"))
        assertEquals("a  b", sanitizeText("a\uDB40\uDC01\uDB40\uDC01b"))
        val cut = sanitizeText("\uD83D\uDE00".repeat(150)) // 300 chars of surrogate pairs, capped without splitting one
        assertTrue(cut.endsWith("…"))
        assertTrue(!cut.dropLast(1).last().isHighSurrogate())
    }

    @Test fun cpuWorkRunsOnItsOwnDispatcherNotTheCallers() {
        happy()
        val seen = java.util.concurrent.ConcurrentLinkedQueue<String>()
        val pool = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "cpu-probe") }
        val caller = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "caller-probe") }
        val before = CpuWork.dispatcher
        CpuWork.dispatcher = object : kotlinx.coroutines.CoroutineDispatcher() {
            override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) = pool.execute { seen += Thread.currentThread().name; block.run() }
        }
        try {
            val o = runBlocking(caller.asCoroutineDispatcher()) {
                recoverAdapter(roomUrl, AdapterUpdates.AUTO, { error("no") }, {}, emptySet(), store, client, indexUrl, 3000)
            }
            assertIs<RecoverOutcome.Applied>(o)
        } finally {
            CpuWork.dispatcher = before; pool.shutdown(); caller.shutdown()
        }
        // page scan, index parse, sha256 + file parse
        assertEquals(3, seen.size, seen.toString())
        assertTrue(seen.all { it == "cpu-probe" })
    }
}
