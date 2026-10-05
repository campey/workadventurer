package app.workadventurer.nav

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.abs
import kotlin.math.floor

enum class Facing { UP, RIGHT, DOWN, LEFT }

/** A point in map pixels. */
data class Pt(val x: Double, val y: Double)

/** A tile grid of walkable/blocked cells. Mirrors the `MapNav` class in src/map-nav.mjs. */
class NavGrid(val w: Int, val h: Int, val tile: Int, private val blocked: BooleanArray) {
    init {
        require(w > 0 && h > 0 && tile > 0 && blocked.size == w * h) {
            "bad grid ${w}x$h tile=$tile cells=${blocked.size}"
        }
    }

    fun inBounds(tx: Int, ty: Int) = tx in 0 until w && ty in 0 until h

    /** Out of bounds counts as blocked. */
    fun isTileBlocked(tx: Int, ty: Int) = !inBounds(tx, ty) || blocked[ty * w + tx]

    fun pxToTile(px: Double, py: Double): Pair<Int, Int> = floor(px / tile).toInt() to floor(py / tile).toInt()

    fun tileCenterPx(tx: Int, ty: Int) = Pt(tx * tile + tile / 2.0, ty * tile + tile / 2.0)

    fun isPxBlocked(px: Double, py: Double): Boolean {
        val (tx, ty) = pxToTile(px, py)
        return isTileBlocked(tx, ty)
    }

    /** Nearest free tile to (tx,ty), spiralling outward ring by ring in raster order; null if none within [maxR]. */
    fun nearestFree(tx: Int, ty: Int, maxR: Int = 40): Pair<Int, Int>? {
        if (!isTileBlocked(tx, ty)) return tx to ty
        for (r in 1..maxR) {
            for (dy in -r..r) {
                for (dx in -r..r) {
                    if (maxOf(abs(dx), abs(dy)) != r) continue
                    if (!isTileBlocked(tx + dx, ty + dy)) return (tx + dx) to (ty + dy)
                }
            }
        }
        return null
    }

    fun blockedIndices(): IntArray = blocked.indices.filter { blocked[it] }.toIntArray()

    companion object {
        fun fromBlockedIndices(w: Int, h: Int, tile: Int, indices: IntArray): NavGrid {
            val b = BooleanArray(w * h)
            for (i in indices) if (i in b.indices) b[i] = true
            return NavGrid(w, h, tile, b)
        }

        /** The baked `collision.json` shape: `{width,height,tile,blocked:[tile indices]}` (other keys ignored). */
        fun fromBakedJson(json: String): NavGrid {
            val o = Json.parseToJsonElement(json).jsonObject
            return fromBlockedIndices(
                o.getValue("width").jsonPrimitive.int,
                o.getValue("height").jsonPrimitive.int,
                o.getValue("tile").jsonPrimitive.int,
                o.getValue("blocked").jsonArray.map { it.jsonPrimitive.int }.toIntArray(),
            )
        }
    }
}
