package app.workadventurer.app.session

import app.workadventurer.protocol.Area
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.Player
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the UI, notification buttons and (later) media buttons can ask the session to do. */
sealed interface Command {
    data class Join(val config: RoomConfig) : Command
    data object Leave : Command
}

sealed interface Connection {
    data object Disconnected : Connection
    data object Connecting : Connection
    data object Connected : Connection
    data class Reconnecting(val attempt: Int, val inMs: Long) : Connection
    data class Failed(val message: String) : Connection
}

data class SessionState(
    val connection: Connection = Connection.Disconnected,
    val roomName: String = "",
    val players: List<Player> = emptyList(), // sorted by name, case-insensitive
    val areas: List<Area> = emptyList(),
    val inAreas: List<Area> = emptyList(),
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
 * Thread-safety: [dispatch] runs on the caller's thread while runs execute on [scope]'s threads. Every
 * dispatch bumps a generation under [lock]; a run only writes state or adopts a connection while its
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

    fun dispatch(cmd: Command) = synchronized(lock) {
        generation++
        val gen = generation
        job?.cancel(); job = null
        conn?.close(); conn = null
        when (cmd) {
            is Command.Join -> {
                // Set synchronously so observers never see the previous room's (or a stale Failed) state first.
                _state.value = SessionState(connection = Connection.Connecting, roomName = cmd.config.roomUrl)
                job = scope.launch { run(cmd.config, gen) }
            }
            Command.Leave -> _state.value = SessionState()
        }
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
        c.state.players.collect { map ->
            setState(gen) {
                it.copy(
                    players = map.values.sortedBy { p -> p.name.lowercase() },
                    inAreas = c.state.currentAreas(),
                )
            }
        }
    }
}
