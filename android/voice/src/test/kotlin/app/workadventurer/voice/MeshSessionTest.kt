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
    private class FakeLink(val id: String, var answer: String? = "ANSWER-SDP", var offer: String? = "OFFER-SDP") : PeerLink {
        val offers = mutableListOf<String>()
        val answersAccepted = mutableListOf<String>()
        var offersCreated = 0
        override suspend fun createOffer(): String? { offersCreated++; return offer }
        override fun acceptAnswer(answerSdp: String) { answersAccepted += answerSdp }
        val candidates = mutableListOf<PeerSignal.Candidate>()
        var closed = false
        override suspend fun acceptOffer(offerSdp: String): String? { offers += offerSdp; return answer }
        override fun addRemoteCandidate(candidate: PeerSignal.Candidate) { candidates += candidate }
        override fun close() { closed = true }
        override suspend fun statsSummary(): String = "stats-of-$id"
    }

    private class Rig {
        val made = mutableMapOf<String, FakeLink>()
        val sent = mutableListOf<List<String>>()
        val logs = mutableListOf<String>()
        var nextAnswer: String? = "ANSWER-SDP"
        var nextOffer: String? = "OFFER-SDP"
        val mesh = MeshSession(
            links = { id -> FakeLink(id, nextAnswer, nextOffer).also { made[id] = it } },
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

    // We are the existing member the server asked to offer: send a simple-peer offer, then accept the browser's answer.
    @Test
    fun anInitiatorStartCreatesALinkSendsAnOfferAndAcceptsTheAnswer() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = true)); runCurrent()
        assertEquals(1, r.made.getValue("c1").offersCreated)
        assertEquals(listOf("sp", "sp_9", "c1", """{"type":"offer","sdp":"OFFER-SDP"}"""), r.sent.single())
        r.events.emit(VoiceEvent.Signal("sp", "sp_9", "c1", """{"type":"answer","sdp":"BROWSER-ANSWER"}""")); runCurrent()
        assertEquals(listOf("BROWSER-ANSWER"), r.made.getValue("c1").answersAccepted)
        assertEquals(setOf("c1"), r.mesh.activeConnections); job.cancel()
    }

    @Test
    fun anOfferWithNoUsableCandidatesClosesTheLinkAndSendsNothing() = runTest {
        val r = Rig(); r.nextOffer = null
        val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = true)); runCurrent()
        assertTrue(r.made.getValue("c1").closed); assertTrue(r.sent.isEmpty()); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }

    @Test
    fun aDuplicateInitiatorStartDoesNotOfferTwice() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = true)); r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = true)); runCurrent()
        assertEquals(1, r.made.getValue("c1").offersCreated); assertEquals(1, r.sent.size); job.cancel()
    }

    @Test
    fun anAnswerForAnUnknownConnectionIsIgnored() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Signal("sp", "sp_9", "ghost", """{"type":"answer","sdp":"X"}""")); runCurrent()
        assertTrue(r.made.isEmpty()); assertTrue(r.sent.isEmpty()); job.cancel()
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
            override suspend fun createOffer(): String? = null
            override fun acceptAnswer(answerSdp: String) {}
            override suspend fun acceptOffer(offerSdp: String): String? = throw IllegalStateException("libwebrtc said no")
            override fun addRemoteCandidate(candidate: PeerSignal.Candidate) {}
            override fun close() {} } }, { _, _, _, _ -> }, {})
        val ev = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 4)
        val j2 = backgroundScope.launch { boom.run(ev) }; runCurrent()
        ev.emit(offer()); runCurrent()
        assertTrue(boom.activeConnections.isEmpty()); job.cancel(); j2.cancel()
    }

    // Final review, Important: the server's restart path sends a NEW connection id for a peer we already have a link to; the old
    // link must not linger (it holds a PeerConnection and ICE ports, and could play audio twice).
    @Test
    fun aFreshConnectionIdForTheSamePeerRetiresTheOldLink() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = true)); runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c2", initiator = false)); runCurrent()
        assertTrue(r.made.getValue("c1").closed)
        assertEquals(false, r.made.getValue("c2").closed)
        assertEquals(setOf("c2"), r.mesh.activeConnections)
        // and the retired id stays dead
        r.events.emit(VoiceEvent.Signal("sp", "sp_9", "c1", """{"type":"answer","sdp":"LATE"}""")); runCurrent()
        assertTrue(r.made.getValue("c1").answersAccepted.isEmpty()); job.cancel()
    }

    @Test
    fun aDifferentPeerInTheSameSpaceKeepsItsLink() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(VoiceEvent.Start("sp", "sp_9", "c1", initiator = false)); r.events.emit(VoiceEvent.Start("sp", "sp_8", "c2", initiator = false)); runCurrent()
        assertEquals(setOf("c1", "c2"), r.mesh.activeConnections); job.cancel()
    }

    // Final review, Important: cancelling the mesh (leave, socket drop) must close its links itself, on its own coroutine,
    // instead of leaving a racing teardown on another thread.
    @Test
    fun cancellingTheMeshClosesEveryLink() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer("c1")); r.events.emit(offer("c2", "sp_8")); runCurrent()
        job.cancel(); runCurrent()
        assertTrue(r.made.values.all { it.closed }); assertTrue(r.mesh.activeConnections.isEmpty())
    }

    // For the live "red mic" investigation: one line per connection (never SDP, ids or addresses), from each link.
    @Test
    fun theStatsSummaryHasOneLinePerLiveConnection() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        assertEquals(emptyList(), r.mesh.statsSummary())
        r.events.emit(offer("c1")); r.events.emit(offer("c2", "sp_8")); runCurrent()
        val lines = r.mesh.statsSummary()
        assertEquals(2, lines.size)
        assertTrue(lines.all { it.startsWith("[") && "stats-of-" in it }, lines.toString())
        job.cancel()
    }

    @Test
    fun closeAllClosesEverything() = runTest {
        val r = Rig(); val job = backgroundScope.launch { r.mesh.run(r.events) }; runCurrent()
        r.events.emit(offer("c1")); r.events.emit(offer("c2", "sp_8")); runCurrent()
        r.mesh.closeAll()
        assertTrue(r.made.values.all { it.closed }); assertTrue(r.mesh.activeConnections.isEmpty()); job.cancel()
    }
}
