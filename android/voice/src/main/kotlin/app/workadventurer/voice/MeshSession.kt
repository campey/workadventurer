package app.workadventurer.voice

import app.workadventurer.protocol.VoiceEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.merge

interface PeerLink {
    /** The answer SDP for [offerSdp], or null if it can't be used (for example zero ICE candidates). */
    suspend fun acceptOffer(offerSdp: String): String?

    /** We are the offerer: the offer SDP to send, or null if it can't be used (for example zero ICE candidates). */
    suspend fun createOffer(): String?

    /** We are the offerer and the peer asked for another offer on the same connection: the new offer SDP, or null if unusable. */
    suspend fun renegotiate(): String?

    /** The remote peer's answer to the offer we created. */
    fun acceptAnswer(answerSdp: String)

    fun addRemoteCandidate(candidate: PeerSignal.Candidate)
    fun close()

    /** One short line of counts and states for logs (never SDP, ids or addresses); empty if there is nothing to say. */
    suspend fun statsSummary(): String = ""
}

fun interface PeerLinkFactory { suspend fun create(connectionId: String): PeerLink }
fun interface SignalSink { fun send(spaceName: String, peerSpaceUserId: String, connectionId: String, signal: String) }

/**
 * One WebRTC link per server-assigned connection id (a 3-person bubble is a mesh). Events are handled one at a time, in
 * order. The server assigns the role per connection: `initiator = true` means we send the offer, otherwise we answer.
 */
class MeshSession(
    private val links: PeerLinkFactory,
    private val sink: SignalSink,
    private val log: (String) -> Unit,
) {
    private class Entry(val spaceName: String, val peer: String, val link: PeerLink) {
        /** True when the server made us the initiator of this connection: only the initiator can answer a renegotiate request. */
        @Volatile var offerer = false

        /** True once we sent an answer: a later offer on this connection is a renegotiation, and a failure must not kill the link. */
        @Volatile var answered = false
    }

    private val active = LinkedHashMap<String, Entry>()
    private val closedIds = LinkedHashSet<String>() // late signals for these are dropped, never resurrected

    val activeConnections: Set<String> get() = synchronized(active) { active.keys.toSet() }

    /**
     * [statsEveryMs] > 0 reports [statsSummary] lines to [onStats] on this same coroutine, between events: libwebrtc objects
     * must never be read from another thread while a negotiation or a teardown may be using or disposing them.
     */
    suspend fun run(events: Flow<VoiceEvent>, statsEveryMs: Long = 0, onStats: (String) -> Unit = {}) {
        val ticks = if (statsEveryMs > 0) flow<VoiceEvent?> { while (true) { delay(statsEveryMs); emit(null) } } else emptyFlow()
        try {
            merge(events, ticks).collect { e ->
                try {
                    if (e == null) statsSummary().forEach(onStats) else handle(e)
                } catch (c: CancellationException) { throw c } catch (t: Throwable) { log("voice event failed: ${t.message}") }
            }
        } finally {
            // On this coroutine, after any in-flight negotiation has returned: a teardown racing from another thread could
            // dispose a PeerConnection that native code is still using, or miss a link inserted a moment later.
            closeAll()
        }
    }

    private fun isClosed(id: String) = synchronized(closedIds) { id in closedIds }

    private suspend fun handle(e: VoiceEvent) {
        when (e) {
            is VoiceEvent.Start -> {
                if (isClosed(e.connectionId)) return
                if (e.initiator) offer(e) else link(e.spaceName, e.peerSpaceUserId, e.connectionId)
            }
            is VoiceEvent.Signal -> {
                if (isClosed(e.connectionId)) { log("[${e.connectionId}] signal for a closed connection, ignored"); return }
                when (val s = SimplePeerSignal.parse(e.signal)) {
                    is PeerSignal.Offer -> answer(e, s)
                    is PeerSignal.Candidate -> synchronized(active) { active[e.connectionId] }?.link?.addRemoteCandidate(s)
                    is PeerSignal.Answer -> {
                        val l = synchronized(active) { active[e.connectionId] }?.link
                        if (l == null) log("[${e.connectionId}] answer for an unknown connection, ignored") else l.acceptAnswer(s.sdp)
                    }
                    PeerSignal.Renegotiate -> renegotiate(e)
                    null -> log("[${e.connectionId}] unsupported signal ignored: ${SimplePeerSignal.describe(e.signal)}")
                }
            }
            is VoiceEvent.Disconnect -> closeWhere { it.spaceName == e.spaceName && it.peer == e.peerSpaceUserId }
            is VoiceEvent.SpaceLeft -> closeWhere { it.spaceName == e.spaceName }
        }
    }

    private suspend fun link(space: String, peer: String, id: String): PeerLink {
        synchronized(active) { active[id] }?.let { return it.link }
        // The server restarts a connection with a NEW id when ours didn't come up in time: retire the old link for this peer.
        val stale = synchronized(active) { active.filter { (_, v) -> v.spaceName == space && v.peer == peer }.keys.toList() }
        stale.forEach { log("[$it] superseded by [$id] for the same peer"); drop(it) }
        val l = links.create(id)
        synchronized(active) { active[id] = Entry(space, peer, l) }
        return l
    }

    private suspend fun offer(e: VoiceEvent.Start) {
        val isNew = synchronized(active) { e.connectionId !in active }
        val l = link(e.spaceName, e.peerSpaceUserId, e.connectionId)
        if (!isNew) return // a duplicate start: the offer is already out
        synchronized(active) { active[e.connectionId]?.offerer = true }
        val sdp = try { l.createOffer() } catch (c: CancellationException) { throw c } catch (t: Throwable) {
            log("[${e.connectionId}] offer failed: ${t.message}"); null
        }
        if (sdp == null) { log("[${e.connectionId}] no usable offer, tearing down"); drop(e.connectionId); return }
        sink.send(e.spaceName, e.peerSpaceUserId, e.connectionId, SimplePeerSignal.offer(sdp))
        log("[${e.connectionId}] offered")
    }

    /**
     * A browser that joined muted has no audio in the first negotiation; when its user unmutes it sends `{type: renegotiate}`
     * and waits for the initiator to offer again. We only act when we are the initiator; as the answerer the browser re-offers
     * by itself. A re-offer we can't use keeps the working connection rather than tearing it down.
     */
    private suspend fun renegotiate(e: VoiceEvent.Signal) {
        val entry = synchronized(active) { active[e.connectionId] }
        if (entry == null) { log("[${e.connectionId}] renegotiate for an unknown connection, ignored"); return }
        if (!entry.offerer) { log("[${e.connectionId}] renegotiate request while we answer: the peer offers by itself, ignored"); return }
        val sdp = try { entry.link.renegotiate() } catch (c: CancellationException) { throw c } catch (t: Throwable) {
            log("[${e.connectionId}] re-offer failed: ${t.message}"); null
        }
        if (sdp == null) { log("[${e.connectionId}] no usable re-offer, keeping the connection"); return }
        sink.send(e.spaceName, e.peerSpaceUserId, e.connectionId, SimplePeerSignal.offer(sdp))
        log("[${e.connectionId}] re-offered")
    }

    private suspend fun answer(e: VoiceEvent.Signal, offer: PeerSignal.Offer) {
        val l = link(e.spaceName, e.peerSpaceUserId, e.connectionId)
        val entry = synchronized(active) { active[e.connectionId] }
        val again = entry?.answered == true
        val sdp = try { l.acceptOffer(offer.sdp) } catch (c: CancellationException) { throw c } catch (t: Throwable) {
            log("[${e.connectionId}] offer failed: ${t.message}"); null
        }
        if (sdp == null) {
            // A first offer we can't answer is a dead connection; a re-offer we can't answer leaves the working one alone.
            if (again) { log("[${e.connectionId}] no usable answer to a re-offer, keeping the connection"); return }
            log("[${e.connectionId}] no usable answer, tearing down"); drop(e.connectionId); return
        }
        entry?.answered = true
        sink.send(e.spaceName, e.peerSpaceUserId, e.connectionId, SimplePeerSignal.answer(sdp))
        log("[${e.connectionId}] answered")
    }

    private fun closeWhere(match: (Entry) -> Boolean) {
        val ids = synchronized(active) { active.filterValues(match).keys.toList() }
        ids.forEach { drop(it) }
    }

    private fun drop(id: String) {
        val entry = synchronized(active) { active.remove(id) }
        synchronized(closedIds) {
            closedIds += id
            if (closedIds.size > 64) closedIds.remove(closedIds.first())
        }
        try { entry?.link?.close() } catch (t: Throwable) { log("[$id] close failed: ${t.message}") }
    }

    /** `[<connection id>] <link summary>` for each live connection (the connection id is a random uuid, not a person). */
    suspend fun statsSummary(): List<String> {
        val live = synchronized(active) { active.map { (id, e) -> id to e.link } }
        return live.map { (id, link) -> "[$id] ${try { link.statsSummary() } catch (t: Throwable) { "stats failed: ${t.message}" }}" }
    }

    fun closeAll() { synchronized(active) { active.keys.toList() }.forEach { drop(it) } }
}
