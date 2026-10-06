package app.workadventurer.voice

import app.workadventurer.protocol.VoiceEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class MeshSessionTest {
    private class FakeLink(val id: String, var answer: String? = "ANSWER-SDP") : PeerLink {
        val offers = mutableListOf<String>()
        val candidates = mutableListOf<PeerSignal.Candidate>()
        var closed = false
        override suspend fun acceptOffer(offerSdp: String): String? { offers += offerSdp; return answer }
        override fun addRemoteCandidate(candidate: PeerSignal.Candidate) { candidates += candidate }
        override fun close() { closed = true }
    }

    private class Rig {
        val made = mutableMapOf<String, FakeLink>()
        val sent = mutableListOf<List<String>>()
        val logs = mutableListOf<String>()
        var nextAnswer: String? = "ANSWER-SDP"
        val mesh = MeshSession(
            links = { id -> FakeLink(id, nextAnswer).also { made[id] = it } },
            sink = { space, peer, conn, signal -> sent += listOf(space, peer, conn, signal) },
            log = { logs += it },
        )
        val events = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 16)
    }

    private fun offer(conn: String = "c1", peer: String = "sp_9") = VoiceEvent.Signal("sp", peer, conn, """{"type":"offer","sdp":"OFFER"}""")

    @Test
    fun aNonInitiatorStartThenAnOfferIsAnsweredToTheSender() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = false)); r.events.emit(offer()); runCurrent()
        assertEquals(listOf("OFFER"), r.made.getValue("c1").offers)
        assertEquals(listOf("sp", "sp_9", "c1", """{"type":"answer","sdp":"ANSWER-SDP"}"""), r.sent.single())
        assertEquals(setOf("c1"), r.mesh.activeConnections); job.cancel()
    }

    @Test
    fun anOfferWithoutAStartStillCreatesTheLinkAndIsAnswered() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer()); runCurrent()
        assertEquals(1, r.sent.size); job.cancel()
    }

    // Review Focus 4
    @Test
    fun aDuplicateStartDoesNotCreateASecondLink() = runTest {
        val r = Rig(); var creates = 0
        val mesh = MeshSession({ id -> creates++; FakeLink(id) }, { _, _, _, _ -> }, {})
        val job = backgroundScope.launch { mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", false)); r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", false)); runCurrent()
        assertEquals(1, creates); job.cancel()
    }

    @Test
    fun anInitiatorStartIsLoggedAsUnsupportedAndCreatesNothing() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = true)); runCurrent()
        assertTrue(r.made.isEmpty()); assertTrue(r.logs.any { "initiate" in it }); job.cancel()
    }

    // Review Focus 2
    @Test
    fun anAnswerWithNoUsableCandidatesClosesTheLinkAndSendsNothing() = runTest {
        val r = Rig(); r.nextAnswer = null
        val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer()); runCurrent()
        assertTrue(r.made.getValue("c1").closed); assertTrue(r.sent.isEmpty()); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }

    // Review Focus 1 and 3
    @Test
    fun signalsForATornDownConnectionAreIgnoredAndNeverResurrectIt() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer()); runCurrent()
        r.events.emit(VoiceEvent.Disconnect("sp", "sp_9")); runCurrent()
        assertTrue(r.made.getValue("c1").closed)
        r.events.emit(offer()); r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", false)); runCurrent()
        assertEquals(1, r.made.size); assertEquals(1, r.sent.size); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }

    @Test
    fun aDisconnectClosesOnlyThatPeersLinks() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer("c1", "sp_9")); r.events.emit(offer("c2", "sp_8")); runCurrent()
        r.events.emit(VoiceEvent.Disconnect("sp", "sp_9")); runCurrent()
        assertTrue(r.made.getValue("c1").closed); assertEquals(false, r.made.getValue("c2").closed)
        assertEquals(setOf("c2"), r.mesh.activeConnections); job.cancel()
    }

    @Test
    fun leavingTheSpaceClosesEveryLinkInIt() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer("c1", "sp_9")); r.events.emit(offer("c2", "sp_8")); runCurrent()
        r.events.emit(VoiceEvent.SpaceLeft("sp")); runCurrent()
        assertTrue(r.made.values.all { it.closed }); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }

    // Review Focus 5
    @Test
    fun garbageAndUnknownSignalsDoNotCrashTheMeshOrStopLaterEvents() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Signal("sp", "sp_9", "c1", "{{{ nope")); r.events.emit(VoiceEvent.Signal("sp", "sp_9", "c1", """{"type":"renegotiate"}"""))
        r.events.emit(offer("c2")); runCurrent()
        assertEquals(1, r.sent.size); job.cancel()
    }

    @Test
    fun candidatesGoToTheLinkAndALinkThatThrowsOnOfferIsDropped() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer()); runCurrent()
        r.events.emit(VoiceEvent.Signal("sp", "sp_9", "c1", """{"type":"candidate","candidate":{"candidate":"candidate:1","sdpMid":"1","sdpMLineIndex":1}}""")); runCurrent()
        assertEquals(listOf(PeerSignal.Candidate("candidate:1", "1", 1)), r.made.getValue("c1").candidates)
        val boom = MeshSession({ object : PeerLink {
            override suspend fun acceptOffer(offerSdp: String): String? = throw IllegalStateException("libwebrtc said no")
            override fun addRemoteCandidate(candidate: PeerSignal.Candidate) {}
            override fun close() {} } }, { _, _, _, _ -> }, {})
        val ev = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 4)
        val j2 = backgroundScope.launch { boom.run(ev) }; runCurrent()
        ev.emit(offer()); runCurrent()
        assertTrue(boom.activeConnections.isEmpty()); job.cancel(); j2.cancel()
    }

    @Test
    fun closeAllClosesEverything() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer("c1")); r.events.emit(offer("c2", "sp_8")); runCurrent()
        r.mesh.closeAll()
        assertTrue(r.made.values.all { it.closed }); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }
}
