package app.workadventurer.app

import java.io.File
import java.nio.file.Files
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CallLogFilesTest {
    private val dir: File = Files.createTempDirectory("calllogs").toFile().also { it.deleteOnExit() }
    private var now = 1_791_452_400_000L // 2026-10-08 09:40:00 UTC
    private fun files(maxFiles: Int = 10, maxTotalBytes: Long = 1_000_000, maxFileBytes: Long = 100_000) =
        CallLogFiles(dir, clock = { now }, zone = ZoneId.of("UTC"), maxFiles = maxFiles, maxTotalBytes = maxTotalBytes, maxFileBytes = maxFileBytes)

    private fun logs() = dir.listFiles()!!.sortedBy { it.name }

    @Test
    fun aJoinStartsAFileNamedByTimeAndRoom() {
        val f = files()
        f.start("https://play.workadventu.re/@/afrolabs/afrolabs/open-space", listOf("# app 0.1.0"))
        f.end()
        assertEquals(listOf("2026-10-08T09-40-00_afrolabs-afrolabs-open-space.log"), logs().map { it.name })
    }

    @Test
    fun theHeaderComesFirstThenTimestampedTaggedLines() {
        val f = files()
        f.start("https://play.workadventu.re/@/a/b/c", listOf("# app 0.1.0", "# room https://play.workadventu.re/@/a/b/c"))
        now += 1_234
        f.append("WaVoice", "answered")
        f.end()
        assertEquals(
            listOf("# app 0.1.0", "# room https://play.workadventu.re/@/a/b/c", "09:40:01.234 WaVoice answered"),
            logs().single().readLines(),
        )
    }

    // The point of the feature: a second call must not overwrite or mix into the first.
    @Test
    fun eachJoinGetsItsOwnFile() {
        val f = files()
        f.start("https://play.workadventu.re/@/a/b/c", emptyList()); f.append("WaConn", "first"); f.end()
        now += 60_000
        f.start("https://play.workadventu.re/@/a/b/c", emptyList()); f.append("WaConn", "second"); f.end()
        val all = logs()
        assertEquals(2, all.size)
        assertTrue(all[0].readText().contains("first") && !all[0].readText().contains("second"))
        assertTrue(all[1].readText().contains("second"))
    }

    @Test
    fun startingWhileOneIsOpenClosesTheOldOne() {
        val f = files()
        f.start("https://play.workadventu.re/@/a/b/c", emptyList()); f.append("WaConn", "one")
        now += 1_000
        f.start("https://play.workadventu.re/@/a/b/d", emptyList()); f.append("WaConn", "two")
        f.end()
        assertTrue(logs()[0].readText().contains("one") && !logs()[0].readText().contains("two"))
    }

    @Test
    fun linesWithNoOpenFileAreDroppedWithoutError() {
        val f = files()
        f.append("WaConn", "nobody is listening")
        f.start("https://play.workadventu.re/@/a/b/c", emptyList()); f.end()
        f.append("WaConn", "after the call")
        assertTrue(logs().single().readLines().none { "nobody" in it || "after" in it })
    }

    @Test
    fun onlyTheNewestFilesAreKept() {
        val f = files(maxFiles = 3)
        repeat(5) { i ->
            now += 60_000
            f.start("https://play.workadventu.re/@/a/b/r$i", emptyList()); f.append("WaConn", "call $i"); f.end()
        }
        assertEquals(listOf("r2", "r3", "r4"), logs().map { it.name.substringAfter("_").removeSuffix(".log").substringAfterLast("-") })
    }

    @Test
    fun theOldestFilesGoWhenTheTotalIsTooBig() {
        val f = files(maxFiles = 50, maxTotalBytes = 600)
        repeat(4) { i ->
            now += 60_000
            f.start("https://play.workadventu.re/@/a/b/r$i", emptyList())
            f.append("WaConn", "x".repeat(150)); f.end()
        }
        assertTrue(logs().sumOf { it.length() } <= 600, logs().map { it.length() }.toString())
        assertTrue(logs().any { "r3" in it.name }, "the newest must survive")
    }

    @Test
    fun theCurrentFileIsNeverPrunedEvenIfItAloneIsOverTheLimit() {
        val f = files(maxTotalBytes = 100)
        f.start("https://play.workadventu.re/@/a/b/c", emptyList())
        f.append("WaConn", "x".repeat(500))
        f.start("https://play.workadventu.re/@/a/b/d", emptyList())
        f.append("WaConn", "y".repeat(500))
        assertTrue(logs().any { it.readText().contains("y".repeat(500)) })
    }

    // An hour-long call must not be able to fill the phone.
    @Test
    fun aRunawayFileStopsGrowingWithOneMarker() {
        val f = files(maxFileBytes = 300)
        f.start("https://play.workadventu.re/@/a/b/c", emptyList())
        repeat(100) { f.append("WaVoice", "stats line ".repeat(3)) }
        f.end()
        val text = logs().single().readText()
        assertTrue(text.length < 600, text.length.toString())
        assertEquals(1, Regex("log full").findAll(text).count())
    }

    @Test
    fun roomSlugsAreFilenameSafeAndMarkStaging() {
        assertEquals("afrolabs-afrolabs-open-space", roomSlug("https://play.workadventu.re/@/afrolabs/afrolabs/open-space"))
        assertEquals("staging-tcm-workadventure-wa-village", roomSlug("https://play.staging.workadventu.re/@/tcm/workadventure/wa-village"))
        assertEquals("room", roomSlug("not a url"))
        assertTrue(roomSlug("https://play.workadventu.re/@/a/b/../../etc/pass wd?x=1#y").all { it.isLetterOrDigit() || it == '-' })
        assertTrue(roomSlug("https://play.workadventu.re/@/" + "x".repeat(300) + "/y/z").length <= 60)
    }
}
