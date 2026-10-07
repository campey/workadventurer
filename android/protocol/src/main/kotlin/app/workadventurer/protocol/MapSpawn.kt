package app.workadventurer.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.random.Random

/**
 * Where WorkAdventure starts a player when the room's `.wam` has no start AREA: on a tile of the Tiled map's `start` layer, or
 * failing that of a layer flagged `startLayer = true` (east/west entrances). The centre of a random non-empty tile, or null if
 * the map has no usable start layer. Tolerant like [app.workadventurer.nav.CollisionBuilder]: anything unexpected gives null.
 */
fun pickTmjSpawn(tmjJson: String, rnd: Random = Random.Default): Spawn? {
    val root = try { Json.parseToJsonElement(tmjJson) as? JsonObject } catch (e: Exception) { null } ?: return null
    val w = (root["width"] as? JsonPrimitive)?.intOrNull ?: return null
    val h = (root["height"] as? JsonPrimitive)?.intOrNull ?: return null
    val tile = (root["tilewidth"] as? JsonPrimitive)?.intOrNull ?: return null
    if (w <= 0 || h <= 0 || tile <= 0) return null
    val layers = tileLayers(root["layers"] as? JsonArray)

    fun tilesOf(l: JsonObject): List<Int> {
        val data = l["data"] as? JsonArray ?: return emptyList() // base64/chunked data: unsupported, like the collision builder
        return data.withIndex().filter { (i, g) -> i < w * h && (g as? JsonPrimitive)?.longOrNull?.let { it != 0L } == true }.map { it.index }
    }

    val named = layers.firstOrNull { it.nameOrNull() == "start" }?.takeIf { tilesOf(it).isNotEmpty() }
    val chosen = named ?: layers.firstOrNull { it.isStartLayer() && tilesOf(it).isNotEmpty() } ?: return null
    val cell = tilesOf(chosen).let { it[rnd.nextInt(it.size)] }
    return Spawn((cell % w) * tile + tile / 2, (cell / w) * tile + tile / 2, chosen.nameOrNull())
}

private fun JsonObject.nameOrNull() = (this["name"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.isStartLayer(): Boolean = (this["properties"] as? JsonArray).orEmpty().any { p ->
    val o = p as? JsonObject
    (o?.get("name") as? JsonPrimitive)?.contentOrNull == "startLayer" && (o["value"] as? JsonPrimitive)?.booleanOrNull == true
}

private fun tileLayers(layers: JsonArray?): List<JsonObject> = layers.orEmpty().flatMap { e: JsonElement ->
    val o = e as? JsonObject ?: return@flatMap emptyList()
    when ((o["type"] as? JsonPrimitive)?.contentOrNull) {
        "tilelayer" -> listOf(o)
        "group" -> tileLayers(o["layers"] as? JsonArray)
        else -> emptyList()
    }
}
