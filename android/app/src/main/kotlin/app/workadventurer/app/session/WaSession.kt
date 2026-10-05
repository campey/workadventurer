package app.workadventurer.app.session

import app.workadventurer.nav.Navigator
import app.workadventurer.nav.Pt
import app.workadventurer.nav.Target
import app.workadventurer.nav.frontOf
import app.workadventurer.nav.snapToFree
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.Player
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.toFacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the UI, notification buttons and (later) media buttons can ask the session to do. */
sealed interface Command {
    data class Join(val config: RoomConfig) : Command
    data object Leave : Command
    data class Follow(val userId: Int) : Command
    data class WalkToPlayer(val userId: Int) : Command
    data class WalkToArea(val areaKey: String) : Command // Area.id ?: Area.name
    data object StopMoving : Command
}

sealed interface Connection {
    data object Disconnected : Connection
    data object Connecting : Connection
    data object Connected : Connection
    data class Reconnecting(val attempt: Int, val inMs: Long) : Connection
    data class Failed(val message: String) : Connection
}

/** What the avatar is doing about movement right now. */
sealed interface Activity {
    data object Idle : Activity
    data class WalkingTo(val label: String) : Activity
    data class Following(val label: String) : Activity
}

data class SessionState(
    val connection: Connection = Connection.Disconnected,
    val roomName: String = "",
    val players: List<Player> = emptyList(), // sorted by name, case-insensitive
    val areas: List<Area> = emptyList(),
    val inAreas: List<Area> = emptyList(),
    val activity: Activity = Activity.Idle,
)

typealias ConnectionFactory = (RoomConfig) -> PusherConnection

/**
 * Owns one room presence: state out, [Command]s in. No Android imports, so it unit-tests on the JVM.
 *
 * A first-attempt [JoinFailed] (bad room/version) is final; anything else, and any drop after we were
 * connected, reconnects with a fresh connection (fresh login) and capped exponential backoff. The backoff
 * only resets once a connection has stayed up for [stableAfterMs], so a connection that joins and drops
 * straight away can't hammer the server (or flicker an avatar in and out of a shared room) every second.
 *
 * Movement commands ([Command.Follow] etc.) are ignored unless [Connection.Connected]; a new movement replaces
 * the current one; Join, Leave, a failed join and a dropped connection all cancel it.
 *
 * Thread-safety: [dispatch] runs on the caller's thread while runs execute on [scope]'s threads. Every
 * Join/Leave bumps a generation under [lock]; a run only writes state or adopts a connection while its
 * generation is still current, so a late write from a cancelled run can never override a newer Leave/Join.
 */
class WaSession(
    private val scope: CoroutineScope,
    private val factory: ConnectionFactory,
    private val backoffMs: (attempt: Int) -> Long = { minOf(30_000L, 1_000L shl (it - 1).coerceAtMost(5)) },
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val stableAfterMs: Long = 30_000,
) {
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private val lock = Any()
    private var generation = 0
    private var job: Job? = null
    private var conn: PusherConnection? = null
    private var moveJob: Job? = null
    private var moveSeq = 0

    fun dispatch(cmd: Command) {
        synchronized(lock) {
            when (cmd) {
                is Command.Join -> {
                    val gen = restart()
                    // Set synchronously so observers never see the previous room's (or a stale Failed) state first.
                    _state.value = SessionState(connection = Connection.Connecting, roomName = cmd.config.roomUrl)
                    job = scope.launch { run(cmd.config, gen) }
                }
                Command.Leave -> {
                    restart()
                    _state.value = SessionState()
                }
                is Command.Follow -> startMovement { c ->
                    val p = c.state.players.value[cmd.userId] ?: return@startMovement null
                    Plan(Activity.Following(label(p))) { nav -> nav.follow({ targetOf(c, cmd.userId) }) }
                }
                is Command.WalkToPlayer -> startMovement { c ->
                    val p = c.state.players.value[cmd.userId] ?: return@startMovement null
                    Plan(Activity.WalkingTo(label(p))) { nav ->
                        nav.navTo(
                            target = Pt(p.x.toDouble(), p.y.toDouble()),
                            stopWithin = 24.0,
                            getTarget = { targetOf(c, cmd.userId)?.let { frontOf(it, c.position(), 64.0, c.grid.value) } },
                            face = { targetOf(c, cmd.userId)?.let { Pt(it.x, it.y) } },
                        )
                    }
                }
                is Command.WalkToArea -> startMovement { c ->
                    val a = c.state.areas.firstOrNull { (it.id ?: it.name) == cmd.areaKey } ?: return@startMovement null
                    Plan(Activity.WalkingTo(a.name)) { nav ->
                        val centre = Pt(a.x + a.w / 2.0, a.y + a.h / 2.0)
                        nav.navTo(c.grid.value?.snapToFree(centre.x, centre.y) ?: centre, stopWithin = 24.0)
                    }
                }
                Command.StopMoving -> stopMovement()
            }
        }
    }

    /** Ends the current presence run (and any movement) and returns the new generation. Caller holds [lock]. */
    private fun restart(): Int {
        generation++
        job?.cancel(); job = null
        conn?.close(); conn = null
        stopMovement()
        return generation
    }

    private class Plan(val activity: Activity, val run: suspend (Navigator) -> Unit)

    private fun label(p: Player) = p.name.ifBlank { "Unnamed player" }

    private fun targetOf(c: PusherConnection, userId: Int): Target? =
        c.state.players.value[userId]?.let { Target(it.x.toDouble(), it.y.toDouble(), it.direction.toFacing()) }

    /** Caller holds [lock]. Only while Connected; a new movement replaces the current one. */
    private fun startMovement(build: (PusherConnection) -> Plan?) {
        val c = conn ?: return
        if (_state.value.connection != Connection.Connected) return
        val plan = build(c) ?: return
        moveJob?.cancel()
        val id = ++moveSeq
        val gen = generation
        _state.update { it.copy(activity = plan.activity) }
        moveJob = scope.launch {
            try {
                plan.run(Navigator({ c.grid.value }, c, nowMs))
            } finally {
                synchronized(lock) {
                    if (gen == generation && id == moveSeq) {
                        moveJob = null
                        _state.update { it.copy(activity = Activity.Idle) }
                    }
                }
            }
        }
    }

    /** Caller holds [lock]. */
    private fun stopMovement() {
        moveSeq++
        moveJob?.cancel(); moveJob = null
        _state.update { it.copy(activity = Activity.Idle) }
    }

    private fun setState(gen: Int, f: (SessionState) -> SessionState) = synchronized(lock) {
        if (gen == generation) _state.update(f)
    }

    /** Adopt [c] as the live connection, unless a newer dispatch has already superseded this run. */
    private fun adopt(gen: Int, c: PusherConnection): Boolean = synchronized(lock) {
        if (gen != generation) false else { conn = c; true }
    }

    private suspend fun run(cfg: RoomConfig, gen: Int) {
        var attempt = 0
        var everConnected = false
        while (true) {
            val c = factory(cfg)
            if (!adopt(gen, c)) { c.close(); return }
            var upAt = -1L
            try {
                c.connect()
                everConnected = true
                upAt = nowMs()
                setState(gen) { it.copy(connection = Connection.Connected, areas = c.state.areas) }
                coroutineScope {
                    // A child of this run, so it can't outlive it or leak past a Leave.
                    val mirror = launch { mirrorState(c, gen) }
                    try { c.closed.await() } finally { mirror.cancel() }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: JoinFailed) {
                if (!everConnected) {
                    setState(gen) { it.copy(connection = Connection.Failed(e.message ?: "join failed")) }
                    return
                }
                // After an earlier success a join failure is treated as transient: retry below.
            } catch (e: Exception) {
                // transient: retry below
            } finally {
                synchronized(lock) { if (gen == generation) stopMovement() }
                c.close()
                c.state.clear()
            }
            if (upAt >= 0 && nowMs() - upAt >= stableAfterMs) attempt = 0
            attempt++
            val wait = backoffMs(attempt)
            setState(gen) {
                it.copy(connection = Connection.Reconnecting(attempt, wait), players = emptyList(), inAreas = emptyList())
            }
            delay(wait)
        }
    }

    private suspend fun mirrorState(c: PusherConnection, gen: Int) {
        // Pose too, so `inAreas` follows the avatar as it walks.
        combine(c.state.players, c.state.myPose) { players, _ -> players }.collect { map ->
            setState(gen) {
                it.copy(players = map.values.sortedBy { p -> p.name.lowercase() }, inAreas = c.state.currentAreas())
            }
        }
    }
}
