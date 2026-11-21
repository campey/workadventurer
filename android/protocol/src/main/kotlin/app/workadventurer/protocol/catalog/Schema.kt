package app.workadventurer.protocol.catalog

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/**
 * Downloadable adapter files (mirror of the CLI's src/catalog/schema.mjs). The app applies only the
 * hash and the handshake query; `protoFamily` is validated as a string but is not a refusal reason,
 * and `meeting` / `movement` are ignored (unknown fields are ignored; wrong types of known ones are not).
 */
val HASH_RE = Regex("^[0-9a-f]{8}$")
private val SERVERS = setOf("production", "staging")
private val NAME_RE = Regex("^[A-Za-z][A-Za-z0-9]{0,31}$")
private val VALUE_RE = Regex("^[A-Za-z0-9._:{}-]{0,64}$")
private val LABEL_RE = Regex("^[A-Za-z0-9._-]{1,32}$")
private val PLACEHOLDERS = setOf("{tabId}", "{uuid}")
private val FORBIDDEN = setOf("roomid", "version", "charactertextureids", "token")
private const val MAX_PARAMS = 12

/** The whitelisted content of a valid adapter file. */
data class AdapterFile(
    val id: String,
    val waVersion: String,
    val apiVersionHash: String,
    val server: String,
    val protoFamily: String,
    val handshakeQuery: Map<String, String>,
)

sealed class Checked {
    data class Ok(val file: AdapterFile) : Checked()
    data class Bad(val reason: String) : Checked()
}

sealed class Parsed {
    data class Value(val json: JsonElement) : Parsed()
    data class Error(val reason: String) : Parsed()
}

/** Strict UTF-8 decode (a leading BOM is stripped) then JSON parse; never throws. */
fun parseJsonBytes(bytes: ByteArray): Parsed = try {
    val dec = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
    var text = dec.decode(ByteBuffer.wrap(bytes)).toString()
    if (text.startsWith("\uFEFF")) text = text.substring(1)
    Parsed.Value(Json.parseToJsonElement(text))
} catch (e: Exception) {
    Parsed.Error("not valid JSON")
}

private fun JsonElement.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** Check an adapter file (already parsed). */
fun validateAdapterFile(json: JsonElement): Checked {
    fun bad(r: String) = Checked.Bad(r)
    val o = json as? JsonObject ?: return bad("file must be an object")
    val schema = o["schema"] as? JsonPrimitive
    if (schema == null || schema.isString || schema.content.toDoubleOrNull() != 1.0) return bad("schema must be 1")
    val id = o["id"]?.str()
    if (id == null || !LABEL_RE.matches(id)) return bad("id is invalid")
    val wa = o["waVersion"]?.str()
    if (wa == null || !LABEL_RE.matches(wa)) return bad("waVersion is invalid")
    val hash = o["apiVersionHash"]?.str()
    if (hash == null || !HASH_RE.matches(hash)) return bad("apiVersionHash must be 8 lowercase hex characters")
    val server = o["server"]?.str()
    if (server == null || server !in SERVERS) return bad("server must be one of ${SERVERS.joinToString(", ")}")
    val family = o["protoFamily"]?.str() ?: return bad("protoFamily must be a string")
    var query: Map<String, String> = emptyMap()
    val hs = o["handshake"]
    if (hs != null) {
        val q = ((hs as? JsonObject)?.get("query")) as? JsonObject ?: return bad("handshake.query must be an object")
        if (q.size > MAX_PARAMS) return bad("handshake.query has more than $MAX_PARAMS parameters")
        val out = LinkedHashMap<String, String>()
        for ((name, v) in q) {
            if (name.lowercase() in FORBIDDEN) return bad("handshake.query.$name is forbidden")
            if (!NAME_RE.matches(name)) return bad("handshake.query name \"$name\" is invalid")
            val value = v.str()
            if (value == null || !VALUE_RE.matches(value)) return bad("handshake.query.$name value is invalid")
            if (Regex("\\{[^{}]*\\}|[{}]").findAll(value).any { it.value !in PLACEHOLDERS }) {
                return bad("handshake.query.$name has an unknown placeholder")
            }
            out[name] = value
        }
        query = out
    }
    return Checked.Ok(AdapterFile(id, wa, hash, server, family, query))
}

