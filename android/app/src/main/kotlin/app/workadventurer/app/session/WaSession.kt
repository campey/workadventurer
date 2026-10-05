package app.workadventurer.app.session

import app.workadventurer.protocol.Area
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.Player
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
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
 * A first-attempt [JoinFailed] (bad room/version) is final; anything else, and any drop after we were
 * connected, reconnects with a fresh connection (fresh login) and capped exponential backoff.
 */
class WaSession(
    private val scope: CoroutineScope,
    private val factory: ConnectionFactory,
    private val backoffMs: (attempt: Int) -> Long = { minOf(30_000L, 1_000L shl (it - 1).coerceAtMost(5)) },
) {
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state.asStateFlow()
    private var job: Job? = null
    private var conn: PusherConnection? = null

    fun dispatch(cmd: Command) {
        when (cmd) {
            is Command.Join -> { stop(); job = scope.launch { run(cmd.config) } }
            Command.Leave -> { stop(); _state.value = SessionState() }
        }
    }

    private fun stop() {
        job?.cancel(); job = null
        conn?.close(); conn = null
    }

    private suspend fun run(cfg: RoomConfig) {
        var attempt = 0
        var everConnected = false
        _state.value = SessionState(connection = Connection.Connecting, roomName = cfg.roomUrl)
        while (scope.isActive) {
            val c = factory(cfg)
            conn = c
            try {
                c.connect()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!everConnected && e is JoinFailed) {
                    _state.update { it.copy(connection = Connection.Failed(e.message ?: "join failed")) }
                    return
                }
                c.close()
                attempt++
                val wait = backoffMs(attempt)
                _state.update { it.copy(connection = Connection.Reconnecting(attempt, wait)) }
                delay(wait)
                continue
            }
            everConnected = true
            attempt = 0
            val mirror = scope.launch { mirrorState(c) }
            _state.update { it.copy(connection = Connection.Connected, areas = c.state.areas) }
            c.closed.await()
            mirror.cancel()
            c.close()
            c.state.clear()
            attempt++
            val wait = backoffMs(attempt)
            _state.update {
                it.copy(connection = Connection.Reconnecting(attempt, wait), players = emptyList(), inAreas = emptyList())
            }
            delay(wait)
        }
    }

    private suspend fun mirrorState(c: PusherConnection) {
        c.state.players.collect { map ->
            _state.update {
                it.copy(
                    players = map.values.sortedBy { p -> p.name.lowercase() },
                    inAreas = c.state.currentAreas(),
                )
            }
        }
    }
}
