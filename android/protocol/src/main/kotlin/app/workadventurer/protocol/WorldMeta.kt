package app.workadventurer.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient

/**
 * What a world says about itself in its `.wam` `metadata` (live prod, 2026-11-24): a [name], a [description] (can hold blank
 * lines) and a [thumbnail] picture address. Every field is optional; a blank one is null. The world's own icon is not here: `/map`
 * carries no `metatags` for the worlds we use, so it isn't read (#108).
 */
data class WorldMeta(val name: String?, val description: String?, val thumbnail: String?) {
    val isEmpty: Boolean get() = name == null && description == null && thumbnail == null
}

/** Reads a `.wam`'s `metadata`. Anything unreadable gives an empty [WorldMeta]; a thumbnail that isn't an http(s) address is dropped. */
fun parseWorldMeta(wamJson: String): WorldMeta {
    val metadata = try {
        Json.parseToJsonElement(wamJson).jsonObject["metadata"] as? JsonObject
    } catch (e: Exception) {
        null
    } ?: return WorldMeta(null, null, null)
    fun text(key: String) = try {
        metadata[key]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
        null
    }
    val thumbnail = text("thumbnail")?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
    return WorldMeta(text("name"), text("description"), thumbnail)
}

/** Best-effort: the room's [WorldMeta], or null if its `.wam` can't be fetched (a join must not depend on it). */
suspend fun fetchWorldMeta(http: OkHttpClient, cfg: RoomConfig): WorldMeta? =
    fetchWamJson(http, cfg)?.let { parseWorldMeta(it) }
