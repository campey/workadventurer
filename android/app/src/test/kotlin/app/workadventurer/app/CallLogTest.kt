package app.workadventurer.app

import app.workadventurer.app.session.Connection
import java.io.File
import java.nio.file.Files
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CallLogTest {
    private val dir: File = Files.createTempDirectory("calllog").toFile().also { it.deleteOnExit() }
    private var now = 1_791_452_400_000L
    private val logcat = mutableListOf<String>()
    private val room = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space"
    private val log = CallLog(
        CallLogFiles(dir, clock = { now }, zone = ZoneId.of("UTC")),
        logcat = { tag, msg -> logcat += "$tag $msg" },
        header = { r -> listOf("# room $r") },
    )

    private fun logs() = dir.listFiles()!!.sortedBy { it.name }

    @Test
    fun everyLineStillGoesToLogcat() {
        log.i("WaVoice", "no call yet")
        assertEquals(listOf("WaVoice no call yet"), logcat)
        assertTrue(logs().isEmpty())
    }

    @Test
    fun joiningStartsAFileWithTheHeaderAndLeavingClosesIt() {
        log.onConnection(Connection.Connecting, room)
        log.i("WaConn", "joined room")
        log.onConnection(Connection.Connected, room)
        log.onConnection(Connection.Disconnected, room)
        log.i("WaConn", "after leave")
        val lines = logs().single().readLines()
        assertEquals("# room $room", lines.first())
        assertTrue(lines.any { it.endsWith("WaConn joined room") })
        assertTrue(lines.none { it.endsWith("after leave") }, "nothing is written once the call is over")
    }

    // A dropped connection that comes back is the same call: the quirks around the drop are the interesting part.
    @Test
    fun aDropAndReconnectStayInTheSameFile() {
        log.onConnection(Connection.Connecting, room)
        log.onConnection(Connection.Connected, room)
        now += 5_000
        log.onConnection(Connection.Reconnecting(1, 1_000), room)
        now += 1_000
        log.onConnection(Connection.Connected, room)
        log.onConnection(Connection.Disconnected, room)
        val text = logs().single().readText()
        assertTrue("reconnecting (attempt 1" in text, text)
        assertEquals(2, Regex("WaSession connected").findAll(text).count(), text)
    }

    @Test
    fun aFailedJoinIsRecordedAndEndsTheFile() {
        log.onConnection(Connection.Connecting, room)
        log.onConnection(Connection.Failed("a new version is available"), room)
        log.i("WaConn", "late")
        val text = logs().single().readText()
        assertTrue("a new version is available" in text && "late" !in text, text)
    }

    @Test
    fun joiningAnotherRoomAfterALeaveIsAnotherFile() {
        log.onConnection(Connection.Connecting, room)
        log.onConnection(Connection.Disconnected, room)
        now += 60_000
        log.onConnection(Connection.Connecting, "https://play.staging.workadventu.re/@/tcm/workadventure/wa-village")
        log.onConnection(Connection.Disconnected, "")
        assertEquals(2, logs().size)
    }

    // The idle app starts Disconnected and the UI keeps reporting it; that must not create empty files.
    @Test
    fun beingDisconnectedWithNoCallCreatesNothing() {
        log.onConnection(Connection.Disconnected, "")
        log.onConnection(Connection.Disconnected, "")
        assertTrue(logs().isEmpty())
    }
}
