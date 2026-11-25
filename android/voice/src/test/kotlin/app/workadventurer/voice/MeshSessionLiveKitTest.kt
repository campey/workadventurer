package app.workadventurer.voice

import app.workadventurer.protocol.VoiceEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// A big meeting moves to the server's LiveKit room (#134): the app joins it on the invitation and leaves it again when the server says.
@OptIn(ExperimentalCoroutinesApi::class)
class MeshSessionLiveKitTest {
    private class FakeCall(val space: String) : LiveKitCall {
        var url: String? = null
        var token: String? = null
        var muted: Boolean? = null
        var closed = false
        var failWith: Throwable? = null
        override suspend fun connect(serverUrl: String, token: String) {
            url = serverUrl; this.token = token
            failWith?.let { throw it }
        }
        override fun setMuted(muted: Boolean) { this.muted = muted }
        override fun close() { closed = true }
    }

    private class FakeLink(val id: String) : PeerLink {
        var closed = false
        override suspend fun acceptOffer(offerSdp: String): String? = "A"
        override suspend fun createOffer(): String? = "O"
        override suspend fun renegotiate(): String? = "R"
        override fun acceptAnswer(answerSdp: String) {}
        override fun addRemoteCandidate(candidate: PeerSignal.Candidate) {}
        override fun close() { closed = true }
    }

    private class Rig(withLiveKit: Boolean = true) {
        val calls = mutableListOf<FakeCall>()
        val links = mutableMapOf<String, FakeLink>()
        val statuses = mutableListOf<AudioStatus>()
        val logs = mutableListOf<String>()
        var nextFailure: Throwable? = null
        val mesh = MeshSession(
            links = { id -> FakeLink(id).also { links[id] = it } },
            sink = { _, _, _, _ -> },
            log = { logs += it },
            liveKit = if (withLiveKit) LiveKitFactory { space -> FakeCall(space).also { it.failWith = nextFailure; calls += it } } else null,
            onAudio = { statuses += it },
        )
        val events = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 16)
    }

    private fun invite(space: String = "sp", token: String = "SECRET.TOKEN.X", url: String = "wss://lk.example") = VoiceEvent.LiveKitInvite(space, token, url)

    @Test
    fun anInvitationJoinsTheRoomAndTheMeshLinksOfThatSpaceGo() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_2", "c1", initiator = false))
        r.events.emit(VoiceEvent.Start("other", "sp_3", "c2", initiator = false)); runCurrent()
        r.events.emit(invite()); runCurrent()
        val call = r.calls.single()
        assertEquals("sp", call.space); assertEquals("wss://lk.example", call.url); assertEquals("SECRET.TOKEN.X", call.token)
        assertTrue(r.links.getValue("c1").closed, "the mesh link in the escalated space goes")
        assertFalse(r.links.getValue("c2").closed, "a link in another space is left alone")
        assertEquals(listOf(AudioStatus.Connecting, AudioStatus.Connected), r.statuses)
        job.cancel()
    }

    @Test
    fun theCallStartsMutedAndFollowsTheMuteChoice() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        assertEquals(true, r.calls.single().muted)
        r.mesh.setMuted(false); assertEquals(false, r.calls.single().muted)
        r.mesh.setMuted(true); assertEquals(true, r.calls.single().muted)
        job.cancel()
    }

    @Test
    fun anUnmuteMadeBeforeTheInvitationIsAppliedWhenTheCallConnects() = runTest {
        val r = Rig(); r.mesh.setMuted(false)
        val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        assertEquals(false, r.calls.single().muted)
        job.cancel()
    }

    @Test
    fun theServerEndingTheRoomLeavesIt() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        r.events.emit(VoiceEvent.LiveKitDisconnect("sp")); runCurrent()
        assertTrue(r.calls.single().closed); assertEquals(AudioStatus.None, r.statuses.last())
        job.cancel()
    }

    // Seen live (#150, #134): going back to the mesh arrives as a switch to WEBRTC, with no disconnect message. The *final* switch message
    // names the transport being SHUT DOWN (WEBRTC right after an escalation), so it must never end the room.
    @Test
    fun aSwitchToWebrtcLeavesTheRoom() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        r.events.emit(VoiceEvent.Switch("sp", "LIVEKIT", finalized = false)); runCurrent()
        assertFalse(r.calls.single().closed, "a switch to LiveKit is not a reason to leave")
        r.events.emit(VoiceEvent.Switch("sp", "WEBRTC", finalized = false)); runCurrent()
        assertTrue(r.calls.single().closed); assertEquals(AudioStatus.None, r.statuses.last())
        job.cancel()
    }

    @Test
    fun theFinalSwitchMessageNamesTheOldTransportAndDoesNotEndTheRoom() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        // Right after an escalation the server finalises "WEBRTC": the mesh being shut down.
        r.events.emit(VoiceEvent.Switch("sp", "WEBRTC", finalized = true)); runCurrent()
        assertFalse(r.calls.single().closed)
        assertEquals(AudioStatus.Connected, r.statuses.last())
        job.cancel()
    }

    @Test
    fun aSwitchToWebrtcInAnotherSpaceLeavesThisRoomAlone() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        r.events.emit(VoiceEvent.Switch("other", "WEBRTC", finalized = false)); runCurrent()
        assertFalse(r.calls.single().closed)
        job.cancel()
    }

    @Test
    fun leavingTheSpaceLeavesTheRoom() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        r.events.emit(VoiceEvent.SpaceLeft("other")); runCurrent()
        assertFalse(r.calls.single().closed, "another space is not ours")
        r.events.emit(VoiceEvent.SpaceLeft("sp")); runCurrent()
        assertTrue(r.calls.single().closed)
        job.cancel()
    }

    @Test
    fun aNewerInvitationReplacesTheOne() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite(token = "ONE")); r.events.emit(invite(token = "TWO")); runCurrent()
        assertEquals(2, r.calls.size)
        assertTrue(r.calls[0].closed); assertFalse(r.calls[1].closed); assertEquals("TWO", r.calls[1].token)
        job.cancel()
    }

    @Test
    fun anInvitationForAnotherSpaceReplacesTheCallAsWell() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite(space = "a")); r.events.emit(invite(space = "b")); runCurrent()
        assertTrue(r.calls[0].closed); assertFalse(r.calls[1].closed)
        job.cancel()
    }

    @Test
    fun aRoomThatWontConnectIsReportedAndDoesNotStopTheMesh() = runTest {
        val r = Rig(); r.nextFailure = RuntimeException("bad token")
        val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        assertTrue(r.calls.single().closed); assertEquals(AudioStatus.Failed, r.statuses.last())
        r.events.emit(VoiceEvent.Start("sp", "sp_2", "c9", initiator = false)); runCurrent()
        assertTrue(r.links.containsKey("c9"), "the mesh still works")
        job.cancel()
    }

    @Test
    fun withoutLiveKitSupportTheInvitationChangesNothing() = runTest {
        val r = Rig(withLiveKit = false); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_2", "c1", initiator = false)); r.events.emit(invite()); runCurrent()
        assertFalse(r.links.getValue("c1").closed)
        assertEquals(emptyList(), r.statuses)
        job.cancel()
    }

    @Test
    fun theLogNeverCarriesTheTokenOrTheServerAddress() = runTest {
        val r = Rig(); r.nextFailure = RuntimeException("boom")
        val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        assertTrue(r.logs.none { it.contains("SECRET") || it.contains("lk.example") }, "log leaked: ${r.logs}")
        job.cancel()
    }

    @Test
    fun stoppingTheMeshLeavesTheRoom() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(invite()); runCurrent()
        job.cancel(); runCurrent()
        assertTrue(r.calls.single().closed)
    }
}
