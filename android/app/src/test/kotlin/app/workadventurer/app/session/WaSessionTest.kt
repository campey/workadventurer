package app.workadventurer.app.session

import app.workadventurer.nav.Facing
import app.workadventurer.nav.NavGrid
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import app.workadventurer.proto.UserJoinedMessage
import app.workadventurer.proto.UserLeftMessage
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.Closed
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class WaSessionTest {
    private val cfg = RoomConfig(name = "t")

    private class FakeConn(cfg: RoomConfig, val behaviour: suspend FakeConn.() -> Unit) :
        PusherConnection(OkHttpClient(), cfg) {
        val fakeClosed = CompletableDeferred<Closed>()
        var closeCalls = 0
        val moves = mutableListOf<Triple<Double, Double, Boolean>>() // x, y, moving
        private val fakeGrid = MutableStateFlow<NavGrid?>(null)
        override val closed get() = fakeClosed
        override val grid: StateFlow<NavGrid?> get() = fakeGrid
        override suspend fun connect() = behaviour()
        override fun move(x: Double, y: Double, facing: Facing, moving: Boolean) {
            state.setMyPose(x, y, facing)
            moves += Triple(x, y, moving)
        }
        override fun close() { closeCalls++; fakeClosed.complete(Closed(1000, "bye")) }
    }

    private fun join(
        id: Int, name: String, x: Int = 1, y: Int = 2,
        dir: PositionMessage.Direction = PositionMessage.Direction.DOWN,
    ) = SubMessage(
        userJoinedMessage = UserJoinedMessage(userId = id, name = name, position = PositionMessage(x = x, y = y, direction = dir)),
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

    // close() is idempotent on the real PusherConnection, and both Leave and the run's own cleanup close it.
    @Test
    fun leaveClosesConnectionAndGoesDisconnected() = runTest {
        var conn: FakeConn? = null
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { conn = it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Leave); runCurrent()
        assertEquals(Connection.Disconnected, session.state.value.connection)
        assertTrue(conn!!.closeCalls >= 1, "connection was never closed")
    }

    @Test
    fun secondJoinReplacesFirst() = runTest {
        val made = mutableListOf<FakeConn>()
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { made += it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Join(cfg.copy(name = "second"))); runCurrent()
        assertEquals(2, made.size)
        assertTrue(made[0].closeCalls >= 1, "first connection was never closed")
        assertEquals(Connection.Connected, session.state.value.connection)
    }

    @Test
    fun nothingFromAClosedConnectionReachesStateAfterLeave() = runTest {
        var conn: FakeConn? = null
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { conn = it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Leave); runCurrent()
        conn!!.state.applySub(join(1, "ghost")); runCurrent()
        assertEquals(SessionState(), session.state.value)
    }

    @Test
    fun secondJoinNeverShowsTheFirstConnectionsPlayers() = runTest {
        val made = mutableListOf<FakeConn>()
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { }.also { made += it } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Join(cfg.copy(name = "second"))); runCurrent()
        made[0].state.applySub(join(1, "from-the-old-room")); runCurrent()
        assertTrue(session.state.value.players.isEmpty(), "old room's players leaked: ${session.state.value.players}")
    }

    @Test
    fun aRunThatIgnoresCancellationCannotOverwriteLeave() = runTest {
        // Models a late write from another thread racing Leave: connect() finishes its non-cancellable
        // work after Leave and then fails. That failure must not turn Disconnected into Reconnecting.
        val gate = CompletableDeferred<Unit>()
        val session = WaSession(backgroundScope, { c -> FakeConn(c) {
            withContext(NonCancellable) { gate.await() }
            throw java.io.IOException("late")
        } })
        session.dispatch(Command.Join(cfg)); runCurrent()
        session.dispatch(Command.Leave); runCurrent()
        gate.complete(Unit)
        advanceTimeBy(5_000); runCurrent()
        assertEquals(Connection.Disconnected, session.state.value.connection)
    }

    @Test
    fun aConnectionThatDropsRightAfterJoiningDoesNotResetTheBackoff() = runTest {
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { fakeClosed.complete(Closed(1006, "flap")) } })
        session.dispatch(Command.Join(cfg))
        val waits = mutableListOf<Long>()
        repeat(4) {
            runCurrent()
            val r = session.state.value.connection as Connection.Reconnecting
            waits += r.inMs
            advanceTimeBy(r.inMs + 1)
        }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L), waits)
    }

    @Test
    fun aConnectionThatStayedUpResetsTheBackoff() = runTest {
        val made = mutableListOf<FakeConn>()
        val session = WaSession(
            backgroundScope,
            { c ->
                val i = made.size
                FakeConn(c) { if (i < 2) fakeClosed.complete(Closed(1006, "flap")) }.also { made += it }
            },
            nowMs = { testScheduler.currentTime },
            stableAfterMs = 30_000,
        )
        session.dispatch(Command.Join(cfg))
        repeat(2) { // two quick flaps -> attempts 1 and 2
            runCurrent()
            val r = session.state.value.connection as Connection.Reconnecting
            advanceTimeBy(r.inMs + 1)
        }
        runCurrent()
        assertEquals(Connection.Connected, session.state.value.connection)
        advanceTimeBy(31_000) // the third connection stays up past the stability threshold
        made[2].fakeClosed.complete(Closed(1001, "x")); runCurrent()
        val r = session.state.value.connection as Connection.Reconnecting
        assertEquals(1, r.attempt)
        assertEquals(1_000L, r.inMs)
    }

    @Test
    fun joinFailedAfterAnEarlierSuccessfulConnectionRetriesInsteadOfFailing() = runTest {
        var n = 0
        val session = WaSession(backgroundScope, { c ->
            val i = n++
            FakeConn(c) { if (i == 1) throw JoinFailed("transient server hiccup") else fakeClosed.takeIf { i == 0 }?.complete(Closed(1006, "x")) }
        })
        session.dispatch(Command.Join(cfg)); runCurrent()
        // connection 0 connected then dropped; connection 1 throws JoinFailed -> must keep retrying
        advanceTimeBy(1_001); runCurrent()
        assertIs<Connection.Reconnecting>(session.state.value.connection)
        advanceTimeBy(2_001); runCurrent()
        assertEquals(Connection.Connected, session.state.value.connection)
    }

    /** A connected session with Ada (userId 1) at (300,0) facing LEFT, an area "Fire pit" around (250,50), us at the origin. */
    private fun TestScope.connected(): Pair<WaSession, () -> FakeConn> {
        var conn: FakeConn? = null
        val session = WaSession(
            backgroundScope,
            { c ->
                FakeConn(c) {
                    state.applySub(join(1, "Ada", x = 300, y = 0, dir = PositionMessage.Direction.LEFT))
                    state.areas = listOf(Area("fire", "Fire pit", 200, 0, 100, 100, emptySet(), false, false))
                    state.setMyPosition(0, 0)
                }.also { conn = it }
            },
            nowMs = { testScheduler.currentTime },
        )
        session.dispatch(Command.Join(cfg)); runCurrent()
        return session to { conn!! }
    }

    @Test
    fun followStartsReportsActivityAndWalksTowardThePlayer() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); runCurrent()
        assertEquals(Activity.Following("Ada"), session.state.value.activity)
        advanceTimeBy(5_000); runCurrent()
        assertTrue(conn().moves.isNotEmpty())
        assertTrue(conn().state.myPose.value.x > 100.0, "should have walked toward Ada, at ${conn().state.myPose.value}")
        session.dispatch(Command.StopMoving); runCurrent()
    }

    @Test
    fun stopMovingGoesIdleWithAFinalStop() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); advanceTimeBy(1_000); runCurrent()
        session.dispatch(Command.StopMoving); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        assertFalse(conn().moves.last().third, "last message must be a stop")
        val n = conn().moves.size
        advanceTimeBy(5_000); runCurrent()
        assertEquals(n, conn().moves.size, "no more moves after stopping")
    }

    @Test
    fun followEndsWhenThePlayerLeaves() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); advanceTimeBy(1_000); runCurrent()
        conn().state.applySub(SubMessage(userLeftMessage = UserLeftMessage(userId = 1)))
        advanceTimeBy(1_000); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        assertFalse(conn().moves.last().third)
    }

    @Test
    fun walkToPlayerArrivesAndReturnsToIdle() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.WalkToPlayer(1)); runCurrent()
        assertEquals(Activity.WalkingTo("Ada"), session.state.value.activity)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        val p = conn().state.myPose.value
        assertTrue(kotlin.math.hypot(p.x - 300.0, p.y) < 100.0, "should end near Ada, at $p")
    }

    @Test
    fun walkToAreaGoesToItsCentreAndAnUnknownAreaIsIgnored() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.WalkToArea("nope")); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        assertTrue(conn().moves.isEmpty())
        session.dispatch(Command.WalkToArea("fire")); runCurrent()
        assertEquals(Activity.WalkingTo("Fire pit"), session.state.value.activity)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        val p = conn().state.myPose.value
        assertTrue(kotlin.math.hypot(p.x - 250.0, p.y - 50.0) <= 24.0, "should end at the centre, at $p")
        assertEquals(listOf("Fire pit"), session.state.value.inAreas.map { it.name })
    }

    @Test
    fun aNewMovementReplacesTheCurrentOne() = runTest {
        val (session, _) = connected()
        session.dispatch(Command.Follow(1)); runCurrent()
        session.dispatch(Command.WalkToArea("fire")); runCurrent()
        assertEquals(Activity.WalkingTo("Fire pit"), session.state.value.activity)
        session.dispatch(Command.StopMoving); runCurrent()
    }

    @Test
    fun leaveStopsMovementAndNothingIsSentAfterwards() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); advanceTimeBy(1_000); runCurrent()
        session.dispatch(Command.Leave); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
        val n = conn().moves.size
        advanceTimeBy(5_000); runCurrent()
        assertEquals(n, conn().moves.size, "the old connection kept getting positions after Leave")
    }

    @Test
    fun aDroppedConnectionStopsMovement() = runTest {
        val (session, conn) = connected()
        session.dispatch(Command.Follow(1)); advanceTimeBy(1_000); runCurrent()
        conn().fakeClosed.complete(Closed(1006, "net")); runCurrent()
        assertIs<Connection.Reconnecting>(session.state.value.connection)
        assertEquals(Activity.Idle, session.state.value.activity)
        val n = conn().moves.size
        advanceTimeBy(500); runCurrent() // before the reconnect creates a new FakeConn
        assertEquals(n, conn().moves.size)
    }

    @Test
    fun movementCommandsAreIgnoredUntilConnected() = runTest {
        val session = WaSession(backgroundScope, { c -> FakeConn(c) { } }, nowMs = { testScheduler.currentTime })
        session.dispatch(Command.Follow(1)); runCurrent()          // not joined at all
        session.dispatch(Command.Join(cfg))                        // Connecting, connect() not yet run
        session.dispatch(Command.Follow(1)); runCurrent()
        assertEquals(Activity.Idle, session.state.value.activity)
    }
}
