package app.workadventurer.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

sealed interface PeerSignal {
    data class Offer(val sdp: String) : PeerSignal
    data class Answer(val sdp: String) : PeerSignal
    data class Candidate(val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int) : PeerSignal
}

/** WorkAdventure's browser peers use simple-peer: signals are JSON strings in `{type, sdp | candidate}` shape. */
object SimplePeerSignal {
    private fun JsonElement?.str() = (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    /** Null for anything we don't act on (renegotiate, transceiverRequest, garbage). Never throws. */
    fun parse(json: String): PeerSignal? {
        val o = try { Json.parseToJsonElement(json) as? JsonObject } catch (e: Exception) { null } ?: return null
        return when (o["type"].str()) {
            "offer" -> o["sdp"].str()?.let { PeerSignal.Offer(it) }
            "answer" -> o["sdp"].str()?.let { PeerSignal.Answer(it) }
            "candidate" -> {
                val c = o["candidate"] as? JsonObject ?: return null
                val line = c["candidate"].str() ?: return null
                PeerSignal.Candidate(line, c["sdpMid"].str(), (c["sdpMLineIndex"] as? JsonPrimitive)?.intOrNull ?: 0)
            }
            else -> null // renegotiate, transceiverRequest, unknown
        }
    }

    /**
     * What shape a signal has, for logs: the `type`, the top-level key names, and a transceiver request's `kind`. Never any value
     * that could carry an SDP, ICE credentials or addresses.
     */
    fun describe(json: String): String {
        val o = try { Json.parseToJsonElement(json) } catch (e: Exception) { return "not json" }
        if (o !is JsonObject) return "not an object"
        val type = o["type"].str()?.let { "type=$it " }.orEmpty()
        val kind = ((o["transceiverRequest"] as? JsonObject)?.get("kind")).str()?.let { " kind=$it" }.orEmpty()
        return "${type}keys=[${o.keys.joinToString(", ")}]$kind"
    }

    fun answer(sdp: String): String = buildJsonObject { put("type", "answer"); put("sdp", sdp) }.toString()

    fun offer(sdp: String): String = buildJsonObject { put("type", "offer"); put("sdp", sdp) }.toString()
}
