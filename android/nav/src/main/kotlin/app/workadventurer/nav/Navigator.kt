package app.workadventurer.nav

import kotlinx.coroutines.delay
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** Where the avatar is and how to move it. The live connection implements this; tests fake it. */
interface MovementSink {
    fun position(): Pt
    fun move(x: Double, y: Double, facing: Facing, moving: Boolean)
}

enum class Outcome { ARRIVED, TIMEOUT, TARGET_GONE }

private const val MIN_ITER_MS = 50L

/**
 * Moves an avatar through a [MovementSink]. Port of walkTo/navTo/follow in src/wa-client.mjs, with
 * cancellation instead of an AbortSignal and one final "stopped" message per call instead of one per waypoint.
 */
class Navigator(
    private val grid: () -> NavGrid?,
    private val sink: MovementSink,
    private val nowMs: () -> Long,
) {
    private var facing = Facing.DOWN
    private var moving = false

    private fun emit(x: Double, y: Double, f: Facing, isMoving: Boolean) {
        facing = f
        moving = isMoving
        sink.move(x, y, f, isMoving)
    }

    /** Sends the final "stopped" message if we were moving (or need to turn); a no-op otherwise. */
    private fun stop(lookAt: Facing? = null) {
        if (!moving && lookAt == null) return
        val p = sink.position()
        emit(p.x, p.y, lookAt ?: facing, false)
    }

    /** Steps toward [t] until within [stopWithin] (true) or [deadline] passes (false). Sends no stop. */
    private suspend fun walkLeg(t: Pt, stopWithin: Double, stepPx: Double, tickMs: Long, deadline: Long): Boolean {
        while (true) {
            val p = sink.position()
            val dx = t.x - p.x
            val dy = t.y - p.y
            val dist = hypot(dx, dy)
            if (dist <= stopWithin) return true
            if (nowMs() > deadline) return false
            val step = min(stepPx, dist)
            emit(p.x + dx / dist * step, p.y + dy / dist * step, faceToward(p.x, p.y, t.x, t.y), true)
            delay(tickMs)
        }
    }

    suspend fun walkTo(
        target: Pt,
        stopWithin: Double = 48.0,
        stepPx: Double = 32.0,
        tickMs: Long = 120,
        timeoutMs: Long = 60_000,
        getTarget: (() -> Pt?)? = null,
    ): Outcome {
        val deadline = nowMs() + timeoutMs
        try {
            while (true) {
                if (nowMs() > deadline) return Outcome.TIMEOUT
                val t = if (getTarget != null) (getTarget() ?: return Outcome.TARGET_GONE) else target
                val p = sink.position()
                val dx = t.x - p.x
                val dy = t.y - p.y
                val dist = hypot(dx, dy)
                if (dist <= stopWithin) return Outcome.ARRIVED
                val step = min(stepPx, dist)
                emit(p.x + dx / dist * step, p.y + dy / dist * step, faceToward(p.x, p.y, t.x, t.y), true)
                delay(tickMs)
            }
        } finally {
            stop()
        }
    }

    suspend fun navTo(
        target: Pt,
        stopWithin: Double = 48.0,
        getTarget: (() -> Pt?)? = null,
        face: (() -> Pt?)? = null,
        timeoutMs: Long = 120_000,
        repathMs: Long = 2_000,
    ): Outcome {
        val started = nowMs()
        try {
            while (nowMs() - started < timeoutMs) {
                val iterStart = nowMs()
                val t = if (getTarget != null) (getTarget() ?: return Outcome.TARGET_GONE) else target
                val p = sink.position()
                if (hypot(t.x - p.x, t.y - p.y) <= stopWithin) {
                    stop(lookAt = face?.invoke()?.let { faceToward(p.x, p.y, it.x, it.y) })
                    return Outcome.ARRIVED
                }
                val deadline = iterStart + repathMs
                val path = grid()?.findPath(p, t)
                if (path.isNullOrEmpty()) {
                    // no grid yet, or no route: walk straight toward the goal for this window, then try again
                    walkLeg(t, stopWithin, 32.0, 120, deadline)
                } else {
                    for (wp in path) {
                        if (nowMs() > deadline) break
                        if (!walkLeg(wp, 12.0, 40.0, 100, deadline)) break
                    }
                }
                // Defence in depth: whatever happened above, never spin. (Node hit a live 100% CPU / growing-RSS
                // spin when every leg returned "already arrived" without ever sleeping.)
                val elapsed = nowMs() - iterStart
                if (elapsed < MIN_ITER_MS) delay(MIN_ITER_MS - elapsed)
            }
            return Outcome.TIMEOUT
        } finally {
            stop()
        }
    }

    suspend fun follow(
        getTarget: () -> Target?,
        spacing: Double = 72.0,
        tickMs: Long = 100,
        stepPx: Double = 30.0,
        arriveSlack: Double = 20.0,
    ): Outcome {
        var path: ArrayDeque<Pt>? = null
        var pathAt = 0L
        var pathGoal: Pt? = null
        try {
            while (true) {
                val target = getTarget() ?: return Outcome.TARGET_GONE
                val me = sink.position()
                val goal = followPoint(me, Pt(target.x, target.y), spacing, grid())
                val dGoal = hypot(goal.x - me.x, goal.y - me.y)

                if (dGoal <= arriveSlack) {
                    val f = faceToward(me.x, me.y, target.x, target.y)
                    if (moving || f != facing) emit(me.x, me.y, f, false)
                    path = null
                    delay(tickMs * 2)
                    continue
                }

                val pg = pathGoal
                val stale = path == null || path.isEmpty() || nowMs() - pathAt > 700 ||
                    pg == null || hypot(pg.x - goal.x, pg.y - goal.y) > 80
                if (stale) {
                    val raw = grid()?.findPath(me, goal)
                    path = ArrayDeque(if (!raw.isNullOrEmpty()) raw else listOf(goal))
                    pathAt = nowMs()
                    pathGoal = goal
                }
                val q = path!!
                var wp = q.first()
                var dwp = hypot(wp.x - me.x, wp.y - me.y)
                while (dwp <= stepPx && q.size > 1) {
                    q.removeFirst()
                    wp = q.first()
                    dwp = hypot(wp.x - me.x, wp.y - me.y)
                }
                val step = min(stepPx, max(dwp, dGoal))
                val nx = if (dwp > 0.001) me.x + (wp.x - me.x) / dwp * step else me.x
                val ny = if (dwp > 0.001) me.y + (wp.y - me.y) / dwp * step else me.y
                emit(nx, ny, faceToward(me.x, me.y, wp.x, wp.y), true)
                delay(tickMs)
            }
        } finally {
            stop()
        }
    }
}
