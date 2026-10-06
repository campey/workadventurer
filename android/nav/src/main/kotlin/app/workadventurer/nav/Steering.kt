package app.workadventurer.nav

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/** Where another avatar is and which way it faces. */
data class Target(val x: Double, val y: Double, val facing: Facing)

fun faceToward(fromX: Double, fromY: Double, toX: Double, toY: Double): Facing {
    val dx = toX - fromX
    val dy = toY - fromY
    return if (abs(dx) > abs(dy)) {
        if (dx > 0) Facing.RIGHT else Facing.LEFT
    } else {
        if (dy > 0) Facing.DOWN else Facing.UP
    }
}

/** The point itself if it's on a free tile, else the centre of the nearest free tile, else null. */
fun NavGrid.snapToFree(x: Double, y: Double): Pt? {
    if (!isPxBlocked(x, y)) return Pt(x, y)
    val (tx, ty) = pxToTile(x, y)
    val free = nearestFree(tx, ty) ?: return null
    return tileCenterPx(free.first, free.second)
}

/** Where to stand `spacing` px short of [target], on the side we approach from (last resort for [frontOf]). */
fun standOffPoint(me: Pt, target: Pt, spacing: Double = 72.0, grid: NavGrid? = null): Pt {
    var dx = me.x - target.x
    var dy = me.y - target.y
    var d = hypot(dx, dy)
    if (d < 1) { dx = 0.0; dy = 1.0; d = 1.0 } // on top of them: step below
    val gx = target.x + dx / d * spacing
    val gy = target.y + dy / d * spacing
    return grid?.snapToFree(gx, gy) ?: Pt(gx, gy)
}

/** Where to stand to face [target] from the front: `spacing` px away in the direction they face. */
fun frontOf(target: Target, me: Pt, spacing: Double = 64.0, grid: NavGrid? = null): Pt {
    val (vx, vy) = when (target.facing) {
        Facing.UP -> 0 to -1
        Facing.RIGHT -> 1 to 0
        Facing.DOWN -> 0 to 1
        Facing.LEFT -> -1 to 0
    }
    val gx = target.x + vx * spacing
    val gy = target.y + vy * spacing
    if (grid != null && grid.isPxBlocked(gx, gy)) {
        // The spot in front of them is a wall or off the map (people face walls and desks all the time). Stand at the
        // free point NEAREST US on a ring around them at the same spacing: still in bubble range of them, whereas
        // snapping to "the first free tile" could land 60+ px away.
        grid.nearestFreeOnRing(Pt(target.x, target.y), spacing, me)?.let { return it }
        return grid.snapToFree(gx, gy) ?: standOffPoint(me, Pt(target.x, target.y), spacing, grid)
    }
    return Pt(gx, gy)
}

private const val RING_POINTS = 16

private fun NavGrid.nearestFreeOnRing(center: Pt, radius: Double, me: Pt): Pt? =
    (0 until RING_POINTS)
        .map { k ->
            val a = k * 2 * PI / RING_POINTS
            Pt(center.x + cos(a) * radius, center.y + sin(a) * radius)
        }
        .filter { !isPxBlocked(it.x, it.y) }
        .minByOrNull { hypot(it.x - me.x, it.y - me.y) }
