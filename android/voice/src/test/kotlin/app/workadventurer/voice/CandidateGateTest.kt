package app.workadventurer.voice

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class CandidateGateTest {
    // A candidate followed by "gathering complete" means everything has arrived: no reason to wait.
    @Test
    fun aCandidateThenCompleteReturnsAtOnce() = runTest {
        val g = CandidateGate()
        g.onCandidate(); g.onComplete()
        g.await(gatherTimeoutMs = 4_000, settleMs = 1_000)
        assertEquals(0, currentTime)
    }

    // Final review, Important: libwebrtc can report COMPLETE before the first candidate arrives (seen on the S25). That COMPLETE
    // says nothing about the later ones (the STUN-reflexive address, which matters behind carrier NAT), so the full settle applies.
    @Test
    fun completeBeforeTheFirstCandidateStillGivesTheRestTheFullSettleTime() = runTest {
        val g = CandidateGate()
        g.onComplete()
        launch { kotlinx.coroutines.delay(100); g.onCandidate() }
        var done = false
        launch { g.await(gatherTimeoutMs = 4_000, settleMs = 1_000); done = true }
        advanceTimeBy(900); runCurrent()
        assertEquals(false, done, "returned before the settle time had passed")
        advanceTimeBy(300); runCurrent()
        assertEquals(true, done)
    }

    @Test
    fun noCandidateAtAllGivesUpAfterTheGatherTimeoutWithoutAnExtraSettle() = runTest {
        val g = CandidateGate()
        g.await(gatherTimeoutMs = 4_000, settleMs = 1_000)
        assertEquals(4_000, currentTime)
    }

    @Test
    fun aCandidateWithNoCompleteWaitsOnlyTheSettleTime() = runTest {
        val g = CandidateGate()
        g.onCandidate()
        g.await(gatherTimeoutMs = 4_000, settleMs = 1_000)
        assertEquals(1_000, currentTime)
    }
}
