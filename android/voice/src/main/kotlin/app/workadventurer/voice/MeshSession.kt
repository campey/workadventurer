package app.workadventurer.voice

import app.workadventurer.protocol.VoiceEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow

interface PeerLink {
    /** The answer SDP for [offerSdp], or null if it can't be used (for example zero ICE candidates). */
    suspend fun acceptOffer(offerSdp: String): String?
    fun addRemoteCandidate(candidate: PeerSignal.Candidate)
    fun close()
}

fun interface PeerLinkFactory { suspend fun create(connectionId: String): PeerLink }
fun interface SignalSink { fun send(spaceName: String, peerSpaceUserId: String, connectionId: String, signal: String) }

/**
 * One WebRTC link per server-assigned connection id (a 3-person bubble is a mesh). Events are handled one at a time, in
 * order. Answerer only until M4: a start with `initiator = true` is logged and ignored.
 */
class MeshSession(
    private val links: PeerLinkFactory,
    private val sink: SignalSink,
    private val log: (String) -> Unit,
) {
    private class Entry(val spaceName: String, val peer: String, val link: PeerLink)

    private val active = LinkedHashMap<String, Entry>()
    private val closedIds = LinkedHashSet<String>() // late signals for these are dropped, never resurrected

    val activeConnections: Set<String> get() = synchronized(active) { active.keys.toSet() }

    suspend fun run(events: Flow<VoiceEvent>) {
        events.collect { e ->
            try { handle(e) } catch (c: CancellationException) { throw c } catch (t: Throwable) { log("voice event failed: ${t.message}") }
        }
    }

    private suspend fun handle(e: VoiceEvent) {
        when (e) {
            is VoiceEvent.Start -> {
                if (e.initiator) { log("[${e.connectionId}] we are asked to initiate: not supported yet, ignoring"); return }
                if (e.connectionId in closedIds) return
                link(e.spaceName, e.peerSpaceUserId, e.connectionId)
            }
            is VoiceEvent.Signal -> {
                if (e.connectionId in closedIds) { log("[${e.connectionId}] signal for a closed connection, ignored"); return }
                when (val s = SimplePeerSignal.parse(e.signal)) {
                    is PeerSignal.Offer -> answer(e, s)
                    is PeerSignal.Candidate -> synchronized(active) { active[e.connectionId] }?.link?.addRemoteCandidate(s)
                    is PeerSignal.Answer -> log("[${e.connectionId}] unexpected answer (we never offer yet), ignored")
                    null -> log("[${e.connectionId}] unparseable or unsupported signal, ignored")
                }
            }
            is VoiceEvent.Disconnect -> closeWhere { it.spaceName == e.spaceName && it.peer == e.peerSpaceUserId }
            is VoiceEvent.SpaceLeft -> closeWhere { it.spaceName == e.spaceName }
        }
    }

    private suspend fun link(space: String, peer: String, id: String): PeerLink {
        synchronized(active) { active[id] }?.let { return it.link }
        val l = links.create(id)
        synchronized(active) { active[id] = Entry(space, peer, l) }
        return l
    }

    private suspend fun answer(e: VoiceEvent.Signal, offer: PeerSignal.Offer) {
        val l = link(e.spaceName, e.peerSpaceUserId, e.connectionId)
        val sdp = try { l.acceptOffer(offer.sdp) } catch (c: CancellationException) { throw c } catch (t: Throwable) {
            log("[${e.connectionId}] offer failed: ${t.message}"); null
        }
        if (sdp == null) { log("[${e.connectionId}] no usable answer, tearing down"); drop(e.connectionId); return }
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

    fun closeAll() { synchronized(active) { active.keys.toList() }.forEach { drop(it) } }
}
