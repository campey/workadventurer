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

    private var callId = 0
    /** Mirrors the session: a Join (a Connecting that is not the answer to the question) takes the next call id, a Disconnected resets it. */
    private fun conn(c: Connection, r: String, answered: Boolean = false) {
        if (c == Connection.Connecting && !answered) callId++
        if (c == Connection.Disconnected) callId = 0
        log.onConnection(c, r, callId)
    }

    private fun logs() = dir.listFiles()!!.sortedBy { it.name }

    @Test
    fun everyLineStillGoesToLogcat() {
        log.i("WaVoice", "no call yet")
        assertEquals(listOf("WaVoice no call yet"), logcat)
        assertTrue(logs().isEmpty())
    }

    @Test
    fun joiningStartsAFileWithTheHeaderAndLeavingClosesIt() {
        conn(Connection.Connecting, room)
        log.i("WaConn", "joined room")
        conn(Connection.Connected, room)
        conn(Connection.Disconnected, room)
        log.i("WaConn", "after leave")
        val lines = logs().single().readLines()
        assertEquals("# room $room", lines.first())
        assertTrue(lines.any { it.endsWith("WaConn joined room") })
        assertTrue(lines.none { it.endsWith("after leave") }, "nothing is written once the call is over")
    }

    // A dropped connection that comes back is the same call: the quirks around the drop are the interesting part.
    @Test
    fun aDropAndReconnectStayInTheSameFile() {
        conn(Connection.Connecting, room)
        conn(Connection.Connected, room)
        now += 5_000
        conn(Connection.Reconnecting(1, 1_000), room)
        now += 1_000
        conn(Connection.Connected, room)
        conn(Connection.Disconnected, room)
        val text = logs().single().readText()
        assertTrue("reconnecting (attempt 1" in text, text)
        assertEquals(2, Regex("WaSession connected").findAll(text).count(), text)
    }

    @Test
    fun aFailedJoinIsRecordedAndEndsTheFile() {
        conn(Connection.Connecting, room)
        conn(Connection.Failed("a new version is available"), room)
        log.i("WaConn", "late")
        val text = logs().single().readText()
        assertTrue("a new version is available" in text && "late" !in text, text)
    }

    @Test
    fun joiningAnotherRoomAfterALeaveIsAnotherFile() {
        conn(Connection.Connecting, room)
        conn(Connection.Disconnected, room)
        now += 60_000
        conn(Connection.Connecting, "https://play.staging.workadventu.re/@/tcm/workadventure/wa-village")
        conn(Connection.Disconnected, "")
        assertEquals(2, logs().size)
    }

    // The idle app starts Disconnected and the UI keeps reporting it; that must not create empty files.
    @Test
    fun beingDisconnectedWithNoCallCreatesNothing() {
        conn(Connection.Disconnected, "")
        conn(Connection.Disconnected, "")
        assertTrue(logs().isEmpty())
    }

    @Test
    fun answeringTheAdapterQuestionDoesNotStartANewCallFile() {
        val ask = Connection.NeedsConsent(app.workadventurer.protocol.catalog.AdapterOffer("deadbeef", null))
        conn(Connection.Connecting, room)
        conn(ask, room)
        conn(Connection.Connecting, room, answered = true)
        conn(Connection.Connected, room)
        assertEquals(1, logs().size)
        conn(Connection.Disconnected, room)
        assertEquals(1, logs().size)
    }

    // A Leave and a Join that the state flow conflated: no Disconnected in between, only a new call id on the Connecting.
    @Test
    fun aJoinDuringTheQuestionOrAConflatedLeaveJoinIsANewCallFile() {
        val ask = Connection.NeedsConsent(app.workadventurer.protocol.catalog.AdapterOffer("deadbeef", null))
        log.onConnection(Connection.Connecting, room, 1)
        log.onConnection(ask, room, 1)
        now += 60_000
        log.onConnection(Connection.Connecting, room, 2) // Join while the dialog was open: same state shape as an answer, new id
        assertEquals(2, logs().size)
        now += 60_000
        log.onConnection(Connection.Connecting, room, 3) // Leave+Join conflated to Connecting -> Connecting
        assertEquals(3, logs().size)
        log.onConnection(Connection.Connecting, room, 3) // the same id again is not a new call
        assertEquals(3, logs().size)
    }
}
