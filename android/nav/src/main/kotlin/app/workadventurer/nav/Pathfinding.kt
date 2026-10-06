package app.workadventurer.nav

import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sqrt

// kotlin.math has no SQRT2; sqrt(2.0) is the same double as JavaScript's Math.SQRT2 (1.4142135623730951).
private val SQRT2 = sqrt(2.0)

private class Entry(val f: Double, val i: Int)

/** The same binary min-heap as src/map-nav.mjs (ties resolve identically, so paths match Node exactly). */
private class Heap {
    private val a = ArrayList<Entry>()
    val size get() = a.size

    fun push(i: Int, f: Double) {
        a.add(Entry(f, i))
        var c = a.size - 1
        while (c > 0) {
            val p = (c - 1) shr 1
            if (a[p].f <= a[c].f) break
            val t = a[p]; a[p] = a[c]; a[c] = t
            c = p
        }
    }

    fun pop(): Entry {
        val top = a[0]
        val last = a.removeAt(a.size - 1)
        if (a.isNotEmpty()) {
            a[0] = last
            var p = 0
            while (true) {
                val l = 2 * p + 1
                val r = l + 1
                var m = p
                if (l < a.size && a[l].f < a[m].f) m = l
                if (r < a.size && a[r].f < a[m].f) m = r
                if (m == p) break
                val t = a[m]; a[m] = a[p]; a[p] = t
                p = m
            }
        }
        return top
    }
}

private val DIRS = arrayOf(
    intArrayOf(1, 0), intArrayOf(-1, 0), intArrayOf(0, 1), intArrayOf(0, -1),
    intArrayOf(1, 1), intArrayOf(1, -1), intArrayOf(-1, 1), intArrayOf(-1, -1),
)
private val COSTS = doubleArrayOf(1.0, 1.0, 1.0, 1.0, SQRT2, SQRT2, SQRT2, SQRT2)

/** True if a straight line between two tile centres stays on free tiles (no diagonal corner cutting). */
private fun NavGrid.lineClear(ax: Int, ay: Int, bx: Int, by: Int): Boolean {
    var x0 = ax
    var y0 = ay
    val dx = abs(bx - ax)
    val dy = abs(by - ay)
    val sx = if (ax < bx) 1 else -1
    val sy = if (ay < by) 1 else -1
    var err = dx - dy
    while (true) {
        if (isTileBlocked(x0, y0)) return false
        if (x0 != bx && y0 != by) {
            if (isTileBlocked(x0 + sx, y0) && isTileBlocked(x0, y0 + sy)) return false
        }
        if (x0 == bx && y0 == by) return true
        val e2 = 2 * err
        if (e2 > -dy) { err -= dy; x0 += sx }
        // `dy == 0` quirk kept on purpose: it is what src/map-nav.mjs does, and we test for exact parity.
        if (e2 < dx) { err += if (dy == 0) 0 else dx; y0 += sy }
    }
}

/**
 * Pixel-space path as smoothed waypoints (tile centres), or null if unreachable. Start and goal are snapped
 * to the nearest free tile. A* on an 8-connected grid, then line-of-sight smoothing. Port of `MapNav.findPath`.
 */
fun NavGrid.findPath(from: Pt, to: Pt): List<Pt>? {
    val (sx0, sy0) = pxToTile(from.x, from.y)
    val (gx0, gy0) = pxToTile(to.x, to.y)
    val s = nearestFree(sx0, sy0) ?: return null
    val g = nearestFree(gx0, gy0) ?: return null
    val sx = s.first; val sy = s.second
    val gx = g.first; val gy = g.second
    if (sx == gx && sy == gy) return listOf(tileCenterPx(gx, gy))

    val n = w * h
    val came = IntArray(n) { -1 }
    val gScore = DoubleArray(n) { Double.POSITIVE_INFINITY }
    val start = sy * w + sx
    val goal = gy * w + gx
    gScore[start] = 0.0

    fun heuristic(i: Int): Double { // octile
        val dx = abs(i % w - gx)
        val dy = abs(i / w - gy)
        return (dx + dy) + (SQRT2 - 2) * min(dx, dy)
    }

    val heap = Heap()
    heap.push(start, heuristic(start))
    while (heap.size > 0) {
        val cur = heap.pop().i
        if (cur == goal) break
        val cx = cur % w
        val cy = cur / w
        for (d in DIRS.indices) {
            val dx = DIRS[d][0]
            val dy = DIRS[d][1]
            val nx = cx + dx
            val ny = cy + dy
            if (isTileBlocked(nx, ny)) continue
            if (dx != 0 && dy != 0) {
                if (isTileBlocked(cx + dx, cy) || isTileBlocked(cx, cy + dy)) continue // no corner cutting
            }
            val ni = ny * w + nx
            val ng = gScore[cur] + COSTS[d]
            if (ng < gScore[ni]) {
                gScore[ni] = ng
                came[ni] = cur
                heap.push(ni, ng + heuristic(ni))
            }
        }
    }
    if (came[goal] == -1 && goal != start) return null

    val tiles = ArrayList<IntArray>()
    var i = goal
    while (i != -1) {
        tiles.add(intArrayOf(i % w, i / w))
        if (i == start) break
        i = came[i]
    }
    tiles.reverse()

    val smooth = arrayListOf(tiles[0])
    var anchor = 0
    for (k in 2 until tiles.size) {
        val a = tiles[anchor]
        val c = tiles[k]
        if (!lineClear(a[0], a[1], c[0], c[1])) {
            smooth.add(tiles[k - 1])
            anchor = k - 1
        }
    }
    smooth.add(tiles.last())
    return smooth.map { tileCenterPx(it[0], it[1]) }
}
