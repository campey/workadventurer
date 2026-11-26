package app.workadventurer.app.session

import app.workadventurer.protocol.Closed
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.NewVersionRefused
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.catalog.AdapterAnswer
import app.workadventurer.protocol.catalog.AdapterOffer
import app.workadventurer.protocol.catalog.AdapterUpdates
import app.workadventurer.protocol.catalog.RecoverOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class WaSessionRecoveryTest {
    private val cfg = RoomConfig(name = "t")
    private val refusal = "The server was updated; please refresh"

    private class Conn(cfg: RoomConfig, val behaviour: suspend Conn.() -> Unit) : PusherConnection(OkHttpClient(), cfg) {
        val fakeClosed = CompletableDeferred<Closed>()
        override val closed get() = fakeClosed
        override suspend fun connect() = behaviour()
        override fun close() { fakeClosed.complete(Closed(1000, "bye")) }
    }

    /** Refuses with NEW_VERSION unless the config carries [accept]'s hash; records every config it was asked to connect with. */
    private class World(val acceptHash: String? = null, val acceptQuery: Map<String, String>? = null) {
        val configs = mutableListOf<RoomConfig>()
        val factory: ConnectionFactory = { c ->
            configs += c
            Conn(c) {
                if (c.apiVersionHash != acceptHash || (acceptQuery != null && c.handshakeQuery != acceptQuery)) throw NewVersionRefused("server says: refresh")
            }
        }
    }

    private class FakeRecovery(var outcome: RecoverOutcome, val asks: Boolean = false) : AdapterRecovery {
        var calls = 0
        var offered: AdapterOffer? = null
        var answer: AdapterAnswer? = null
        var gate: CompletableDeferred<Unit>? = null
        val forgotten = mutableListOf<String>()
        override suspend fun forget(hash: String) { forgotten += hash }
        override suspend fun recover(roomUrl: String, ask: suspend (AdapterOffer) -> AdapterAnswer): RecoverOutcome {
            calls++
            gate?.await()
            if (asks) { offered = AdapterOffer("deadbeef", "v9.9.9"); answer = ask(offered!!) }
            return outcome
        }
    }

    private fun TestScope.session(world: World, recovery: AdapterRecovery?) =
        WaSession(backgroundScope, world.factory, recovery = recovery)

    @Test
    fun appliedRetriesOnceWithNewHashAndQuery() = runTest {
        val q = mapOf("x" to "1")
        val world = World(acceptHash = "deadbeef", acceptQuery = q)
        val rec = FakeRecovery(RecoverOutcome.Applied("deadbeef", q, "v9"))
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(Connection.Connected, s.state.value.connection)
        assertEquals(1, rec.calls)
        assertEquals(2, world.configs.size)
        assertEquals("deadbeef", world.configs[1].apiVersionHash)
        assertEquals(q, world.configs[1].handshakeQuery)
        assertEquals(cfg.apiVersionHash, world.configs[0].apiVersionHash)
    }

    @Test
    fun knownWithCachedQueryIsAppliedToo() = runTest {
        val q = mapOf("y" to "2")
        val world = World(acceptHash = "cafe0001", acceptQuery = q)
        val s = session(world, FakeRecovery(RecoverOutcome.Known("cafe0001", q)))
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(Connection.Connected, s.state.value.connection)
        assertEquals(q, world.configs.last().handshakeQuery)
    }

    @Test
    fun secondRefusalShowsTheOriginalMessageAndDoesNotLoop() = runTest {
        val world = World(acceptHash = "never-matches")
        val rec = FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"))
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); advanceTimeBy(120_000); runCurrent()
        assertEquals(Connection.Failed("server says: refresh"), s.state.value.connection)
        assertEquals(1, rec.calls)
        assertEquals(2, world.configs.size)
    }

    @Test
    fun eachNonAppliedOutcomeShowsItsOwnMessageNotTheRefreshText() = runTest {
        val outcomes = listOf(
            RecoverOutcome.Unavailable("offline"), RecoverOutcome.NoEntry("deadbeef"), RecoverOutcome.NeedsAttention("deadbeef", "gate X"),
            RecoverOutcome.Never("deadbeef"), RecoverOutcome.Declined("deadbeef"),
        )
        val messages = outcomes.map { o ->
            val world = World()
            val rec = FakeRecovery(o)
            val s = session(world, rec)
            s.dispatch(Command.Join(cfg)); advanceTimeBy(60_000); runCurrent()
            val c = assertIs<Connection.Failed>(s.state.value.connection)
            assertEquals(1, world.configs.size, "no retry for $o")
            assertEquals(1, rec.calls)
            assertTrue("refresh" !in c.message, c.message)
            c.message
        }
        assertEquals(outcomes.size, messages.toSet().size, "distinct messages")
        assertTrue("no adapter" in messages[1])
        assertTrue("needs attention" in messages[2] && "gate X" in messages[2])
        assertTrue("turned off in Settings" in messages[3])
        assertTrue("couldn't check" in messages[0])
    }

    @Test
    fun knownThatChangesNothingShowsTheOriginalRefusal() = runTest {
        val world = World()
        val s = session(world, FakeRecovery(RecoverOutcome.Known(cfg.apiVersionHash)))
        s.dispatch(Command.Join(cfg)); advanceTimeBy(60_000); runCurrent()
        assertEquals(Connection.Failed("server says: refresh"), s.state.value.connection)
        assertEquals(1, world.configs.size)
    }

    @Test
    fun otherJoinFailuresDoNotStartRecovery() = runTest {
        val rec = FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"))
        val s = WaSession(backgroundScope, { c -> Conn(c) { throw JoinFailed("token expired") } }, recovery = rec)
        s.dispatch(Command.Join(cfg)); advanceTimeBy(60_000); runCurrent()
        assertEquals(Connection.Failed("token expired"), s.state.value.connection)
        assertEquals(0, rec.calls)
    }

    @Test
    fun noRecoveryPortKeepsTodaysBehaviour() = runTest {
        val s = session(World(), null)
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(Connection.Failed("server says: refresh"), s.state.value.connection)
    }

    @Test
    fun consentDialogDownloadAppliesAndReturnsToConnecting() = runTest {
        val world = World(acceptHash = "deadbeef")
        val rec = FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"), asks = true)
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); runCurrent()
        val needs = assertIs<Connection.NeedsConsent>(s.state.value.connection)
        assertEquals("v9.9.9", needs.offer.release)
        s.dispatch(Command.AnswerAdapter(AdapterAnswer.YES)); runCurrent()
        assertEquals(AdapterAnswer.YES, rec.answer)
        assertEquals(Connection.Connected, s.state.value.connection)
    }

    @Test
    fun cancelAnswersNoAndFailsWithDeclinedMessage() = runTest {
        val world = World()
        val rec = object : AdapterRecovery {
            var answer: AdapterAnswer? = null
            override suspend fun recover(roomUrl: String, ask: suspend (AdapterOffer) -> AdapterAnswer): RecoverOutcome {
                answer = ask(AdapterOffer("deadbeef", null))
                return if (answer == AdapterAnswer.NO) RecoverOutcome.Declined("deadbeef") else RecoverOutcome.Applied("deadbeef", emptyMap(), "v")
            }
        }
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); runCurrent()
        s.dispatch(Command.AnswerAdapter(AdapterAnswer.NO)); runCurrent()
        s.dispatch(Command.AnswerAdapter(AdapterAnswer.YES)); runCurrent() // a late second answer is ignored
        assertEquals(AdapterAnswer.NO, rec.answer)
        assertTrue("wasn't downloaded" in assertIs<Connection.Failed>(s.state.value.connection).message)
        assertEquals(1, world.configs.size)
    }

    @Test
    fun leaveWhileAskingStopsRecoveryAndNeverConnects() = runTest {
        val world = World(acceptHash = "deadbeef")
        val rec = FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"), asks = true)
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertIs<Connection.NeedsConsent>(s.state.value.connection)
        s.dispatch(Command.Leave); runCurrent()
        s.dispatch(Command.AnswerAdapter(AdapterAnswer.YES)); runCurrent()
        assertEquals(Connection.Disconnected, s.state.value.connection)
        assertEquals(1, world.configs.size)
    }

    @Test
    fun leaveDuringARecoveryThatIgnoresCancellationNeverUsesTheStaleConfig() = runTest {
        val world = World(acceptHash = "deadbeef")
        val gate = CompletableDeferred<Unit>()
        val rec = AdapterRecovery { _, _ ->
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { gate.await() }
            RecoverOutcome.Applied("deadbeef", emptyMap(), "v9")
        }
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); runCurrent()
        s.dispatch(Command.Leave); runCurrent()
        gate.complete(Unit); runCurrent()
        assertEquals(Connection.Disconnected, s.state.value.connection)
        assertEquals(1, world.configs.size) // only the refused attempt: the applied config was never used
    }

    @Test
    fun recoveryRunsOncePerRefusalEvenWithConcurrentJoins() = runTest {
        val world = World(acceptHash = "deadbeef")
        val rec = FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"))
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); s.dispatch(Command.Join(cfg.copy(name = "u"))); runCurrent()
        assertEquals(1, rec.calls)
        assertEquals(Connection.Connected, s.state.value.connection)
        assertEquals("u", s.state.value.myName)
    }

    private fun TestScope.afterSuccess(rec: AdapterRecovery, configs: MutableList<RoomConfig>): WaSession {
        var n = 0
        return WaSession(backgroundScope, { c ->
            configs += c
            val i = n++
            Conn(c) { if (i == 0) fakeClosed.complete(Closed(1006, "x")) else throw NewVersionRefused("server says: refresh") }
        }, recovery = rec)
    }

    @Test
    fun refusalAfterAnEarlierSuccessRecoversOnceThenFailsWithTheOriginalRefusal() = runTest {
        val configs = mutableListOf<RoomConfig>()
        val rec = FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"))
        val s = afterSuccess(rec, configs)
        s.dispatch(Command.Join(cfg)); runCurrent()
        advanceTimeBy(60_000); runCurrent()
        assertEquals(Connection.Failed("server says: refresh"), s.state.value.connection)
        assertEquals(1, rec.calls)
        assertEquals(3, configs.size) // connected, refused, refused with the adapted config: then it stops
        assertEquals("deadbeef", configs[2].apiVersionHash)
    }

    @Test
    fun refusalAfterAnEarlierSuccessThatRecoveryCannotFixFailsWithItsMessage() = runTest {
        val configs = mutableListOf<RoomConfig>()
        val rec = FakeRecovery(RecoverOutcome.NoEntry("deadbeef"))
        val s = afterSuccess(rec, configs)
        s.dispatch(Command.Join(cfg)); runCurrent()
        advanceTimeBy(60_000); runCurrent()
        assertTrue("no adapter" in assertIs<Connection.Failed>(s.state.value.connection).message)
        assertEquals(1, rec.calls)
        assertEquals(2, configs.size)
    }

    @Test
    fun answeringTheDialogRestoresThePreAskStateAtOnce() = runTest {
        val world = World(acceptHash = "deadbeef")
        val rec = FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"), asks = true)
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertIs<Connection.NeedsConsent>(s.state.value.connection)
        s.dispatch(Command.AnswerAdapter(AdapterAnswer.YES))
        assertEquals(Connection.Connecting, s.state.value.connection) // before the run even resumes
    }

    @Test
    fun startsNewCallNeedsAnIdItHasNotSeen() {
        assertTrue(!startsNewCall(1, Connection.Connecting, 1)) // the answer to the question: same id
        assertTrue(startsNewCall(0, Connection.Connecting, 1))
        assertTrue(startsNewCall(1, Connection.Connecting, 2)) // a Join, even straight after a Connecting
        assertTrue(!startsNewCall(0, Connection.Connected, 1))
    }

    @Test
    fun aJoinTakesTheNextCallIdAndAnAnswerDoesNot() = runTest {
        val world = World(acceptHash = "deadbeef")
        val s = session(world, FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"), asks = true))
        assertEquals(0, s.state.value.callId)
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertIs<Connection.NeedsConsent>(s.state.value.connection)
        assertEquals(1, s.state.value.callId)
        s.dispatch(Command.AnswerAdapter(AdapterAnswer.YES))
        assertEquals(Connection.Connecting, s.state.value.connection)
        assertEquals(1, s.state.value.callId) // still the same call
        runCurrent()
        assertEquals(Connection.Connected, s.state.value.connection)
        assertEquals(1, s.state.value.callId)
        s.dispatch(Command.Leave)
        assertEquals(0, s.state.value.callId)
    }

    @Test
    fun aJoinWhileTheQuestionIsOpenIsANewCall() = runTest {
        val world = World(acceptHash = "deadbeef")
        val s = session(world, FakeRecovery(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"), asks = true))
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertIs<Connection.NeedsConsent>(s.state.value.connection)
        val seen = mutableListOf<Pair<Connection, Int>>()
        backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) { s.state.collect { seen += it.connection to it.callId } }
        s.dispatch(Command.Join(cfg.copy(name = "again"))); runCurrent()
        assertEquals(2, s.state.value.callId)
        // Straight from the question (call 1) to a Connecting of call 2: the pair differs although the connection looks like an answer.
        assertEquals(Connection.Connecting, seen.first { it.second == 2 }.first)
    }

    @Test
    fun aConflatedLeaveAndJoinStillShowsANewCallId() = runTest {
        val world = World(acceptHash = "never")
        val gate = CompletableDeferred<Unit>()
        val s = session(world, FakeRecovery(RecoverOutcome.NoEntry("deadbeef")).also { it.gate = gate })
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(Connection.Connecting, s.state.value.connection)
        val before = s.state.value
        s.dispatch(Command.Leave); s.dispatch(Command.Join(cfg)) // a collector that was busy sees only the end result
        val after = s.state.value
        assertEquals(before.connection, after.connection)
        assertEquals(before.callId + 1, after.callId)
    }

    @Test
    fun aRefusedCachedAdapterIsForgottenSoTheCatalogIsAskedNextTime() = runTest {
        val world = World(acceptHash = "never-matches")
        val rec = FakeRecovery(RecoverOutcome.Known("deadbeef", mapOf("x" to "1"), fromCache = true))
        val s = session(world, rec)
        s.dispatch(Command.Join(cfg)); advanceTimeBy(120_000); runCurrent()
        assertEquals(Connection.Failed("server says: refresh"), s.state.value.connection)
        assertEquals(listOf("deadbeef"), rec.forgotten)
        assertEquals(2, world.configs.size)
    }

    @Test
    fun aCachedAdapterThatChangesNothingButIsRefusedIsForgottenToo() = runTest {
        // The cached file carries the very hash and query the config already has: no retry, but the file is bad.
        val rec = FakeRecovery(RecoverOutcome.Known(cfg.apiVersionHash, cfg.handshakeQuery, fromCache = true))
        val s = session(World(), rec)
        s.dispatch(Command.Join(cfg)); advanceTimeBy(60_000); runCurrent()
        assertEquals(Connection.Failed("server says: refresh"), s.state.value.connection)
        assertEquals(listOf(cfg.apiVersionHash), rec.forgotten)
    }

    @Test
    fun aDownloadedOrBuiltinAdapterTheServerRefusesIsNotForgotten() = runTest {
        for (o in listOf(RecoverOutcome.Applied("deadbeef", emptyMap(), "v9"), RecoverOutcome.Known("deadbeef", emptyMap(), fromCache = false))) {
            val rec = FakeRecovery(o)
            val s = session(World(acceptHash = "never-matches"), rec)
            s.dispatch(Command.Join(cfg)); advanceTimeBy(120_000); runCurrent()
            assertIs<Connection.Failed>(s.state.value.connection)
            assertEquals(emptyList(), rec.forgotten, "$o")
        }
    }

    @Test
    fun aCachedAdapterTheServerAcceptsIsKept() = runTest {
        val rec = FakeRecovery(RecoverOutcome.Known("deadbeef", emptyMap(), fromCache = true))
        val s = session(World(acceptHash = "deadbeef"), rec)
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertEquals(Connection.Connected, s.state.value.connection)
        assertEquals(emptyList(), rec.forgotten)
    }

    @Test
    fun anUnpublishedVersionIsSaidApartFromACatalogFailure() = runTest {
        val s = session(World(), FakeRecovery(RecoverOutcome.VersionUnreadable))
        s.dispatch(Command.Join(cfg)); runCurrent()
        val m = assertIs<Connection.Failed>(s.state.value.connection).message
        assertEquals("This server doesn't publish its version, so the app can't check for an update.", m)
        assertTrue(m != recoveryFailureMessage(RecoverOutcome.Unavailable("x"), "o"))
    }

    @Test
    fun recoveryFailureNeverEscapesAsACrash() = runTest {
        val world = World()
        val s = session(world, { _, _ -> error("boom") })
        s.dispatch(Command.Join(cfg)); runCurrent()
        assertTrue("couldn't check" in assertIs<Connection.Failed>(s.state.value.connection).message)
    }
}
