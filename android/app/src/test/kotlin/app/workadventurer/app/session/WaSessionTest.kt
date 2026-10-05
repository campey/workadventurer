package app.workadventurer.app.session

import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import app.workadventurer.proto.UserJoinedMessage
import app.workadventurer.protocol.Closed
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class WaSessionTest {
    private val cfg = RoomConfig(name = "t")

    private class FakeConn(cfg: RoomConfig, val behaviour: suspend FakeConn.() -> Unit) :
        PusherConnection(OkHttpClient(), cfg) {
        val fakeClosed = CompletableDeferred<Closed>()
        var closeCalls = 0
        override val closed get() = fakeClosed
        override suspend fun connect() = behaviour()
        override fun close() { closeCalls++; fakeClosed.complete(Closed(1000, "bye")) }
    }

    private fun join(id: Int, name: String) = SubMessage(
        userJoinedMessage = UserJoinedMessage(userId = id, name = name, position = PositionMessage(x = 1, y = 2)),
    )

    @Test
    fun joinReachesConnectedAndMirrorsPlayersSorted() = runTest {
        val session = WaSession(backgroundScope, { c -> FakeConn(c) {
            state.applySub(join(1, "bob")); state.applySub(join(2, "Alice"))
        } })
        session.dispatch(Command.Join(cfg))
        runCurrent()
        assertEquals(Connection.Connected, session.state.value.connection)
        assertEquals(listOf("Alice", "bob"), session.state.value.players.map { it.name })
    }

    @Test
    fun firstJoinFailureIsFailedAndNotRetried() = runTest {
        var made = 0
        val session = WaSession(backgroundScope, { c -> made++; FakeConn(c) { throw JoinFailed("token expired") } })
        session.dispatch(Command.Join(cfg))
        advanceTimeBy(120_000)
        runCurrent()
        assertEquals(Connection.Failed("token expired"), session.state.value.connection)
        assertEquals(1, made)
    }

    @Test
    fun dropAfterConnectedReconnectsWithFreshConnectionAndClearsOldPlayers() = runTest {
        val made = mutableListOf<FakeConn>()
        val session = WaSession(backgroundScope, { c ->
            FakeConn(c) { state.applySub(join(made.size, "p${made.size}")) }.also { made += it }
        })
        session.dispatch(Command.Join(cfg))
        runCurrent()
        assertEquals(listOf("p1"), session.state.value.players.map { it.name })
        made[0].fakeClosed.complete(Closed(1001, "x"))
        runCurrent()
        val st = session.state.value.connection
        assertIs<Connection.Reconnecting>(st)
        assertEquals(1, st.attempt)
        assertTrue(session.state.value.players.isEmpty())
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(2, made.size)
        assertEquals(Connection.Connected, session.state.value.connection)
        assertEquals(listOf("p2"), session.state.value.players.map { it.name })
    }

    @Test
    fun repeatedFailuresBackOffAndCapAtThirtySeconds() = runTest {
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { throw java.io.IOException("net down") } })
        session.dispatch(Command.Join(cfg))
        val waits = mutableListOf<Long>()
        repeat(7) {
            runCurrent()
            val r = session.state.value.connection as Connection.Reconnecting
            waits += r.inMs
            advanceTimeBy(r.inMs + 1)
        }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), waits)
    }

    @Test
    fun leaveClosesConnectionAndGoesDisconnected() = runTest {
        var conn: FakeConn? = null
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { conn = it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Leave); runCurrent()
        assertEquals(Connection.Disconnected, session.state.value.connection)
        assertEquals(1, conn!!.closeCalls)
    }

    @Test
    fun secondJoinReplacesFirst() = runTest {
        val made = mutableListOf<FakeConn>()
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { made += it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Join(cfg.copy(name = "second"))); runCurrent()
        assertEquals(2, made.size)
        assertEquals(1, made[0].closeCalls)
        assertEquals(Connection.Connected, session.state.value.connection)
    }
}
