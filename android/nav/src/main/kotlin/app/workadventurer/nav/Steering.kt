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

/**
 * Which tiles [from] can walk to (true = reachable), under the same rules as [findPath] (8 directions, no corner
 * cutting). The start snaps to the nearest free tile; null if there is none. Mirrors `MapNav.reachableFrom`.
 */
fun NavGrid.reachableFrom(from: Pt): BooleanArray? {
    val (fx, fy) = pxToTile(from.x, from.y)
    val (sx, sy) = nearestFree(fx, fy) ?: return null
    val seen = BooleanArray(w * h)
    val stack = ArrayDeque<Int>()
    seen[sy * w + sx] = true
    stack.add(sy * w + sx)
    while (stack.isNotEmpty()) {
        val cur = stack.removeLast()
        val cx = cur % w
        val cy = cur / w
        for (dy in -1..1) for (dx in -1..1) {
            if (dx == 0 && dy == 0) continue
            val nx = cx + dx
            val ny = cy + dy
            if (isTileBlocked(nx, ny)) continue
            if (dx != 0 && dy != 0 && (isTileBlocked(cx + dx, cy) || isTileBlocked(cx, cy + dy))) continue
            if (!seen[ny * w + nx]) { seen[ny * w + nx] = true; stack.add(ny * w + nx) }
        }
    }
    return seen
}

/**
 * Like [snapToFree], but the result is a place [from] can actually walk to: the point itself when it is on a free tile
 * connected to [from], else the centre of the nearest such tile. A free tile in a walled-off pocket, or on an island
 * behind a wall, is skipped. Null when nothing is reachable. Same movement rules as [findPath] (8 directions, no corner
 * cutting). Mirrors `MapNav.reachableFrom` in src/map-nav.mjs.
 */
fun NavGrid.snapToReachable(from: Pt, x: Double, y: Double): Pt? {
    val seen = reachableFrom(from) ?: return null
    val (gx, gy) = pxToTile(x, y)
    if (inBounds(gx, gy) && seen[gy * w + gx]) return Pt(x, y)
    var best: Pt? = null
    var bestD = Double.MAX_VALUE
    for (t in seen.indices) {
        if (!seen[t]) continue
        val c = tileCenterPx(t % w, t / w)
        val d = hypot(c.x - x, c.y - y)
        if (d < bestD) { bestD = d; best = c }
    }
    return best
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
private const val OUTSIDE_STEP_PX = 24.0
private const val OUTSIDE_MAX_PX = 720.0

/**
 * The nearest point to [me] that is [free] and not [inside]: the way out of a region (a bubble, an area), found by
 * widening rings around [me]. Null if nothing within reach qualifies.
 */
fun nearestOutside(me: Pt, inside: (Pt) -> Boolean, free: (Pt) -> Boolean = { true }): Pt? {
    var r = OUTSIDE_STEP_PX
    while (r <= OUTSIDE_MAX_PX) {
        val hit = (0 until RING_POINTS)
            .map { k -> Pt(me.x + cos(k * 2 * PI / RING_POINTS) * r, me.y + sin(k * 2 * PI / RING_POINTS) * r) }
            .firstOrNull { free(it) && !inside(it) }
        if (hit != null) return hit
        r += OUTSIDE_STEP_PX
    }
    return null
}

/**
 * The way out of a region over the walkable tiles of this grid: the first tile centre not [inside] that [me] can walk
 * to, nearest by walking distance (breadth-first, same movement rules as [findPath]), within [OUTSIDE_MAX_PX]. A free
 * point on the far side of a wall is not a way out. Null if nothing reachable qualifies.
 */
fun NavGrid.nearestFreeOutside(me: Pt, inside: (Pt) -> Boolean): Pt? {
    val (mx, my) = pxToTile(me.x, me.y)
    val (sx, sy) = nearestFree(mx, my) ?: return null
    val maxSteps = (OUTSIDE_MAX_PX / tile).toInt()
    val dist = IntArray(w * h) { -1 }
    val queue = ArrayDeque<Int>()
    dist[sy * w + sx] = 0
    queue.add(sy * w + sx)
    while (queue.isNotEmpty()) {
        val cur = queue.removeFirst()
        val cx = cur % w
        val cy = cur / w
        val c = tileCenterPx(cx, cy)
        if (!inside(c)) return c
        if (dist[cur] >= maxSteps) continue
        for (dy in -1..1) for (dx in -1..1) {
            if (dx == 0 && dy == 0) continue
            val nx = cx + dx
            val ny = cy + dy
            if (isTileBlocked(nx, ny)) continue
            if (dx != 0 && dy != 0 && (isTileBlocked(cx + dx, cy) || isTileBlocked(cx, cy + dy))) continue
            if (dist[ny * w + nx] == -1) { dist[ny * w + nx] = dist[cur] + 1; queue.add(ny * w + nx) }
        }
    }
    return null
}

private fun NavGrid.nearestFreeOnRing(center: Pt, radius: Double, me: Pt): Pt? =
    (0 until RING_POINTS)
        .map { k ->
            val a = k * 2 * PI / RING_POINTS
            Pt(center.x + cos(a) * radius, center.y + sin(a) * radius)
        }
        .filter { !isPxBlocked(it.x, it.y) }
        .minByOrNull { hypot(it.x - me.x, it.y - me.y) }
