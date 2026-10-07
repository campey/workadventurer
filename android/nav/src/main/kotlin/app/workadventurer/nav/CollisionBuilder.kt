package app.workadventurer.nav

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.math.floor

// Type-safe accessors: a field of the wrong JSON type reads as null instead of throwing.
private fun JsonElement?.obj() = this as? JsonObject
private fun JsonElement?.arr() = this as? JsonArray
private fun JsonElement?.prim() = this as? JsonPrimitive
private fun JsonElement?.str() = prim()?.takeIf { it.isString }?.contentOrNull
private fun JsonElement?.int() = prim()?.intOrNull
private fun JsonElement?.long() = prim()?.longOrNull
private fun JsonElement?.dbl() = prim()?.doubleOrNull

/**
 * Builds a [NavGrid] from a room's `.tmj` (Tiled map) and `.wam` (map-storage metadata) at runtime.
 * Port of scripts/build-collision.mjs. Deliberately tolerant: a malformed part is skipped, never thrown,
 * so the worst case is a grid more open than the room. Documented gaps: external tilesets (`source` only,
 * no inline tiles) and infinite/chunked maps (layers without a plain `data` array) contribute nothing.
 */
object CollisionBuilder {
    private const val GID_MASK = 0x1fffffffL // strips Tiled's flip flags in the high bits
    private val SMALL_PROP = Regex("(stool|chair)")
    private const val MAX_CELLS = 4_000_000L // real rooms are ~10^4-10^5 cells; this only stops a corrupt or hostile map

    /** The grid, or null if the `.tmj` isn't JSON or has no usable `width`/`height`/`tilewidth`. */
    fun build(wamJson: String, tmjJson: String, entityGrids: Map<String, List<List<Int>>?>? = null): NavGrid? {
        val tmj = parse(tmjJson).obj() ?: return null
        val w = tmj["width"].int() ?: return null
        val h = tmj["height"].int() ?: return null
        val tile = tmj["tilewidth"].int() ?: return null
        if (w <= 0 || h <= 0 || tile <= 0) return null
        if (w.toLong() * h > MAX_CELLS) return null // also guards w*h overflowing Int
        val cells = w * h

        val blocked = BooleanArray(cells)
        val layers = flatten(tmj["layers"].arr()).filter { it["type"].str() == "tilelayer" }

        // (1) the dedicated `collisions` layer: any non-zero cell
        layers.firstOrNull { it["name"].str() == "collisions" }?.let { layer ->
            forEachCell(layer, cells) { i, gid -> if (gid != 0L) blocked[i] = true }
        }

        // (2) tiles flagged `collides: true` in any inline tileset, on any layer
        val collidesGids = HashSet<Long>()
        for (ts in tmj["tilesets"].arr().orEmpty()) {
            val o = ts.obj() ?: continue
            val first = o["firstgid"].long() ?: continue
            for (t in o["tiles"].arr().orEmpty()) {
                val to = t.obj() ?: continue
                val id = to["id"].long() ?: continue
                val collides = to["properties"].arr().orEmpty().any { p ->
                    val po = p.obj()
                    val v = po?.get("value").prim()
                    po?.get("name").str() == "collides" && (v?.booleanOrNull == true || v?.contentOrNull == "true")
                }
                if (collides) collidesGids += first + id
            }
        }
        if (collidesGids.isNotEmpty()) {
            for (layer in layers) {
                forEachCell(layer, cells) { i, gid -> if (gid != 0L && (gid and GID_MASK) in collidesGids) blocked[i] = true }
            }
        }

        // (3) furniture entities from the .wam. With the prefabs' published collision grids, an entity blocks exactly its
        // prefab's solid cells (and a prefab with no grid blocks nothing); otherwise the old approximation: the tile under the
        // centre, plus 3x3 unless it's a stool/chair.
        for ((_, e) in parse(wamJson).obj()?.get("entities").obj().orEmpty()) {
            val eo = e.obj() ?: continue
            val x = eo["x"].dbl() ?: continue
            val y = eo["y"].dbl() ?: continue
            val rawId = eo["prefabRef"].obj()?.get("id").str() ?: ""
            if (entityGrids != null && entityGrids.containsKey(rawId)) {
                val grid = entityGrids[rawId] ?: continue // a prefab with no collision shape is not solid
                val ox = floor((x + tile / 2.0) / tile).toInt()
                val oy = floor((y + tile / 2.0) / tile).toInt()
                grid.forEachIndexed { r, row ->
                    row.forEachIndexed { c, v ->
                        val tx = ox + c
                        val ty = oy + r
                        if (v == 1 && tx in 0 until w && ty in 0 until h) blocked[ty * w + tx] = true
                    }
                }
                continue
            }
            val id = rawId.lowercase()
            val r = if (SMALL_PROP.containsMatchIn(id)) 0 else 1
            val cx = floor((x + tile / 2.0) / tile).toInt()
            val cy = floor((y + tile / 2.0) / tile).toInt()
            for (dy in -r..r) for (dx in -r..r) {
                val tx = cx + dx
                val ty = cy + dy
                if (tx in 0 until w && ty in 0 until h) blocked[ty * w + tx] = true
            }
        }
        return NavGrid(w, h, tile, blocked)
    }

    private fun parse(s: String): JsonElement? = try { Json.parseToJsonElement(s) } catch (e: Exception) { null }

    private fun flatten(layers: JsonArray?): List<JsonObject> = buildList {
        for (l in layers.orEmpty()) {
            val o = l.obj() ?: continue
            if (o["type"].str() == "group") addAll(flatten(o["layers"].arr())) else add(o)
        }
    }

    /** Calls [f] with (cell index, raw gid) for each cell of a layer's plain `data` array, up to [limit] cells. */
    private inline fun forEachCell(layer: JsonObject, limit: Int, f: (Int, Long) -> Unit) {
        val data = layer["data"].arr() ?: return
        for (i in 0 until minOf(data.size, limit)) {
            val gid = data[i].long() ?: continue
            f(i, gid)
        }
    }
}
