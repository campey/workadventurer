package app.workadventurer.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicInteger

/**
 * When is a non-trickle SDP ready to send? libwebrtc can report gathering COMPLETE *before* the first candidate is delivered
 * (seen on the S25), so COMPLETE alone proves nothing. Rules: nothing to send until a first candidate exists (bounded); once
 * one does, COMPLETE seen *after* it means all have arrived, otherwise give the rest (the STUN-reflexive one, which matters
 * behind carrier NAT) [settleMs] to turn up.
 */
internal class CandidateGate {
    private val candidates = AtomicInteger(0)
    private val first = CompletableDeferred<Unit>()
    private val settled = CompletableDeferred<Unit>()

    fun onCandidate() { candidates.incrementAndGet(); first.complete(Unit) }

    /** A COMPLETE that arrives before any candidate is ignored. */
    fun onComplete() { if (candidates.get() > 0) settled.complete(Unit) }

    suspend fun await(gatherTimeoutMs: Long, settleMs: Long) {
        withTimeoutOrNull(gatherTimeoutMs) { first.await() } ?: return // no candidate at all: the caller tears the link down
        withTimeoutOrNull(settleMs) { settled.await() }
    }
}
