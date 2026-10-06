package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.nav.Pt
import app.workadventurer.proto.AskPositionMessage
import app.workadventurer.proto.BatchMessage
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.ErrorScreenMessage
import app.workadventurer.proto.LocatePositionMessage
import app.workadventurer.proto.MeetingInvitationRequestClosedMessage
import app.workadventurer.proto.MeetingInvitationRequestReceivedMessage
import app.workadventurer.proto.MeetingInvitationRequestTooHighMessage
import app.workadventurer.proto.MeetingInvitationResponseReceivedMessage
import app.workadventurer.proto.PingMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.RoomConnectedMessage
import app.workadventurer.proto.RoomJoinedMessage
import app.workadventurer.proto.ServerToClientMessage
import app.workadventurer.proto.SubMessage
import app.workadventurer.proto.UserJoinedMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.nio.file.Files
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PusherConnectionTest {
    private fun s2c(m: ServerToClientMessage): ByteString =
        Envelope.wrap(1, ServerToClientMessage.ADAPTER.encode(m)).toByteString()

    private class Fake(val onOpen: (WebSocket) -> Unit, val onFrame: (WebSocket, ClientToServerMessage) -> Unit) {
        val received = LinkedBlockingQueue<ClientToServerMessage>()
        @Volatile var upgradeRequest: RecordedRequest? = null
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onOpen(webSocket)
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val msg = ClientToServerMessage.ADAPTER.decode(Envelope.unwrap(bytes.toByteArray()).single())
                received.add(msg)
                onFrame(webSocket, msg)
            }

            // A real server answers the client's close frame; without this the mock's
            // queue never drains and MockWebServer.close() throws.
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }
        }
    }

    private fun server(fake: Fake): MockWebServer {
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path!!.startsWith("/anonymLogin") -> MockResponse().setBody("""{"authToken":"TOK","userUuid":"me"}""")
                request.path!!.startsWith("/map") -> MockResponse().setBody("{}")
                request.path!!.startsWith("/ws/room") -> {
                    fake.upgradeRequest = request
                    MockResponse().withWebSocketUpgrade(fake.listener)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        s.start()
        return s
    }

    private fun cfg(s: MockWebServer) =
        RoomConfig(pusherUrl = s.url("/").toString().trimEnd('/'), name = "tester")

    @Test
    fun handshakeJoinsAndTracksPlayers() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) {
                    ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 7))))
                    ws.send(s2c(ServerToClientMessage(batchMessage = BatchMessage(payload = listOf(
                        SubMessage(userJoinedMessage = UserJoinedMessage(userId = 9, name = "Ada", userUuid = "u9",
                            position = PositionMessage(x = 5, y = 6))),
                    )))))
                }
            },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 50)
            withTimeout(5_000) { conn.connect() }
            assertEquals(7, conn.state.myUserId.value)
            // token as websocket subprotocol, Origin header present
            assertEquals("TOK", fake.upgradeRequest!!.getHeader("Sec-WebSocket-Protocol"))
            assertEquals("https://play.workadventu.re", fake.upgradeRequest!!.getHeader("Origin"))
            val join = fake.received.poll(2, TimeUnit.SECONDS)!!.joinRoomFrontMessage!!
            assertEquals("tester", join.name)
            assertEquals(PositionMessage.Direction.DOWN, join.positionMessage!!.direction)
            // spawn fallback when /map has no wamUrl
            assertEquals(320, join.positionMessage!!.x)
            withTimeout(5_000) { while (conn.state.players.value[9] == null) delay(10) }
            assertEquals("Ada", conn.state.players.value.getValue(9).name)
            // keepalive emits userMovesMessage
            val move = generateSequence { fake.received.poll(2, TimeUnit.SECONDS) }
                .first { it.userMovesMessage != null }.userMovesMessage!!
            assertEquals(320, move.position!!.x)
            conn.close()
        }
    }

    @Test
    fun answersPingWithPing() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) {
                    ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 1))))
                    ws.send(s2c(ServerToClientMessage(batchMessage = BatchMessage(payload = listOf(SubMessage(pingMessage = PingMessage()))))))
                }
            },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val pong = generateSequence { fake.received.poll(2, TimeUnit.SECONDS) }
                .first { it.pingMessage != null }
            assertNotNull(pong.pingMessage)
            conn.close()
        }
    }

    @Test
    fun errorScreenBeforeJoinFailsConnect() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(errorScreenMessage = ErrorScreenMessage(title = "Nope", details = "full")))) },
            onFrame = { _, _ -> },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s))
            val e = assertFailsWith<JoinFailed> { withTimeout(5_000) { conn.connect() } }
            assertTrue(e.message!!.contains("Nope"), e.message)
        }
    }

    @Test
    fun failedJoinClosesTheSocketInsteadOfLeavingItOpen() = runBlocking<Unit> {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(errorScreenMessage = ErrorScreenMessage(title = "Nope", details = "full")))) },
            onFrame = { _, _ -> },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s))
            assertFailsWith<JoinFailed> { withTimeout(5_000) { conn.connect() } }
            // Without an explicit close the socket (and its avatar) would stay in the room, kept alive by pings.
            withTimeout(5_000) { conn.closed.await() }
        }
    }

    @Test
    fun silentServerTimesOutInsteadOfHanging() = runBlocking<Unit> {
        val fake = Fake(onOpen = { _ -> }, onFrame = { _, _ -> }) // accepts the upgrade, never says anything
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), joinTimeoutMs = 300)
            val e = assertFailsWith<JoinFailed> { withTimeout(5_000) { conn.connect() } }
            assertTrue(e.message!!.contains("timed out"), e.message)
            withTimeout(5_000) { conn.closed.await() }
        }
    }

    @Test
    fun closeBeforeJoinFailsConnectInsteadOfHanging() = runBlocking {
        val fake = Fake(onOpen = { ws -> ws.close(1008, "bad version") }, onFrame = { _, _ -> })
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s))
            val e = assertFailsWith<JoinFailed> { withTimeout(5_000) { conn.connect() } }
            assertTrue(e.message!!.contains("1008"), e.message)
        }
    }

    @Test
    fun closedCompletesWhenServerDropsAfterJoin() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) {
                    ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 1))))
                    ws.close(1001, "going away")
                }
            },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val c = withTimeout(5_000) { conn.closed.await() }
            assertEquals(1001, c.code)
        }
    }

    /** A pusher that also serves /map -> wam -> tmj, so the background grid load can run. */
    private fun serverWithMap(fake: Fake, tmj: String?, tmjRequests: AtomicInteger = AtomicInteger()): MockWebServer {
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val base = s.url("/").toString().trimEnd('/')
                return when {
                    request.path!!.startsWith("/anonymLogin") -> MockResponse().setBody("""{"authToken":"TOK","userUuid":"me"}""")
                    request.path!!.startsWith("/map") -> MockResponse().setBody("""{"wamUrl":"$base/the.wam"}""")
                    request.path == "/the.wam" -> MockResponse().setBody("""{"mapUrl":"$base/the.tmj","entities":{},"areas":[]}""")
                    request.path == "/the.tmj" -> {
                        tmjRequests.incrementAndGet()
                        if (tmj != null) MockResponse().setBody(tmj) else MockResponse().setResponseCode(500)
                    }
                    request.path!!.startsWith("/ws/room") -> { fake.upgradeRequest = request; MockResponse().withWebSocketUpgrade(fake.listener) }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        s.start()
        return s
    }

    private fun joiningFake() = Fake(
        onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
        onFrame = { ws, msg ->
            if (msg.joinRoomFrontMessage != null)
                ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 7))))
        },
    )

    // 12 x 12 map; tile (10,10) is blocked, and (10,10) is exactly where the (320,320) fallback spawn lands.
    private val spawnBlockedTmj = """{"width":12,"height":12,"tilewidth":32,"tilesets":[],"layers":[
        {"type":"tilelayer","name":"collisions","data":[${(0 until 144).joinToString(",") { if (it == 10 * 12 + 10) "1" else "0" }}]}]}"""

    @Test
    fun moveSendsTheRoundedPositionFacingAndMovingAndUpdatesThePose() = runBlocking<Unit> {
        val fake = joiningFake()
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            fake.received.poll(2, TimeUnit.SECONDS) // the join message
            conn.move(100.4, 200.6, Facing.LEFT, true)
            val m = generateSequence { fake.received.poll(2, TimeUnit.SECONDS) }.first { it.userMovesMessage != null }.userMovesMessage!!
            assertEquals(100, m.position!!.x)
            assertEquals(201, m.position!!.y)
            assertEquals(PositionMessage.Direction.LEFT, m.position!!.direction)
            assertTrue(m.position!!.moving)
            assertEquals(Pt(100.4, 200.6), conn.position())
            assertEquals(Facing.LEFT, conn.state.myPose.value.facing)
            conn.close()
        }
    }

    @Test
    fun theKeepAliveCarriesTheLatestFacingNotAlwaysDown() = runBlocking<Unit> {
        val fake = joiningFake()
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 50)
            withTimeout(5_000) { conn.connect() }
            conn.move(10.0, 10.0, Facing.LEFT, false)
            delay(400)
            val sent = mutableListOf<ClientToServerMessage>()
            fake.received.drainTo(sent) // keepalives keep coming, so drain rather than poll-until-silence
            val last = sent.mapNotNull { it.userMovesMessage }.last()
            assertEquals(PositionMessage.Direction.LEFT, last.position!!.direction)
            conn.close()
        }
    }

    @Test
    fun theGridLoadsInTheBackgroundAfterTheJoin() = runBlocking<Unit> {
        val fake = joiningFake()
        serverWithMap(fake, spawnBlockedTmj).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            withTimeout(5_000) { while (conn.grid.value == null) delay(10) }
            val g = conn.grid.value!!
            assertEquals(12, g.w)
            assertTrue(g.isTileBlocked(10, 10))
            conn.close()
        }
    }

    @Test
    fun aFailedMapDownloadLeavesTheGridNullAndTheJoinIntact() = runBlocking<Unit> {
        val fake = joiningFake()
        serverWithMap(fake, tmj = null).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(7, conn.state.myUserId.value)
            delay(400)
            assertNull(conn.grid.value)
            conn.close()
        }
    }

    @Test
    fun aSpawnInsideAWallIsNudgedToAFreeTileOnceTheGridArrives() = runBlocking<Unit> {
        val fake = joiningFake()
        serverWithMap(fake, spawnBlockedTmj).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            withTimeout(5_000) { while (conn.grid.value == null) delay(10) }
            val g = conn.grid.value!!
            withTimeout(5_000) { while (g.isPxBlocked(conn.position().x, conn.position().y)) delay(10) }
            val p = conn.position()
            assertTrue(!g.isPxBlocked(p.x, p.y), "still in the wall at $p")
            // and it was told to the server, not just remembered locally
            val sent = generateSequence { fake.received.poll(500, TimeUnit.MILLISECONDS) }
                .mapNotNull { it.userMovesMessage?.position }.toList()
            assertTrue(sent.any { !g.isPxBlocked(it.x.toDouble(), it.y.toDouble()) }, "no free-tile position was sent: $sent")
            conn.close()
        }
    }

    @Test
    fun theTmjIsCachedOnDiskBetweenConnections() = runBlocking<Unit> {
        val dir = Files.createTempDirectory("navcache").toFile()
        val fake = joiningFake()
        val tmjRequests = AtomicInteger()
        try {
            serverWithMap(fake, spawnBlockedTmj, tmjRequests).use { s ->
                repeat(2) {
                    val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, cacheDir = dir)
                    withTimeout(5_000) { conn.connect() }
                    withTimeout(5_000) { while (conn.grid.value == null) delay(10) }
                    conn.close()
                }
                assertEquals(1, tmjRequests.get())
            }
        } finally { dir.deleteRecursively() }
    }

    // ---- invitations and locating a player (meetingInvitation* / askPosition) ----

    /** A fake pusher that joins us, hands the test its server-side socket, and lets the test react to each frame. */
    private class LiveFake(react: (WebSocket, ClientToServerMessage) -> Unit = { _, _ -> }) {
        @Volatile var serverWs: WebSocket? = null
        val fake = Fake(
            onOpen = { ws ->
                serverWs = ws
                ws.send(Envelope.wrap(1, ServerToClientMessage.ADAPTER.encode(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))).toByteString())
            },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) {
                    ws.send(Envelope.wrap(1, ServerToClientMessage.ADAPTER.encode(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 7)))).toByteString())
                }
                react(ws, msg)
            },
        )
        fun push(m: ServerToClientMessage) {
            serverWs!!.send(Envelope.wrap(1, ServerToClientMessage.ADAPTER.encode(m)).toByteString())
        }
    }

    private suspend fun waitFor(timeoutMs: Long = 5_000, cond: () -> Boolean) {
        withTimeout(timeoutMs) { while (!cond()) delay(10) }
    }

    @Test
    fun sendInviteSendsTheReceiversUuidAndUserId() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            conn.sendInvite("uuid-ada", 42)
            val req = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }
                .first { it.meetingInvitationRequestMessage != null }.meetingInvitationRequestMessage!!
            assertEquals("uuid-ada", req.receiverUserUuid)
            assertEquals(42, req.receiverUserId)
            conn.close()
        }
    }

    @Test
    fun anIncomingInviteBecomesPendingAndTheClosedMessageClearsIt() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(meetingInvitationRequestReceivedMessage = MeetingInvitationRequestReceivedMessage(
                senderUserUuid = "uuid-bob", senderName = "Bob", senderUserId = 9, senderPlayUri = "https://play/room",
            )))
            waitFor { conn.state.pendingInvites.value.isNotEmpty() }
            assertEquals(listOf(Invite("uuid-bob", "Bob", 9, "https://play/room")), conn.state.pendingInvites.value)

            // another session of ours answered it: the server tells us to drop it
            live.push(ServerToClientMessage(meetingInvitationRequestClosedMessage = MeetingInvitationRequestClosedMessage()))
            waitFor { conn.state.pendingInvites.value.isEmpty() }
            conn.close()
        }
    }

    @Test
    fun respondingSendsTheAnswerAndDropsThePendingInvite() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(meetingInvitationRequestReceivedMessage = MeetingInvitationRequestReceivedMessage(
                senderUserUuid = "uuid-bob", senderName = "Bob", senderPlayUri = "u",
            )))
            waitFor { conn.state.pendingInvites.value.isNotEmpty() }
            conn.respondToInvite("uuid-bob", accept = true)
            val resp = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }
                .first { it.meetingInvitationResponseMessage != null }.meetingInvitationResponseMessage!!
            assertTrue(resp.accept)
            assertEquals("uuid-bob", resp.requestSenderUserUuid)
            assertTrue(conn.state.pendingInvites.value.isEmpty())
            conn.close()
        }
    }

    @Test
    fun theOutcomeOfAnInviteWeSentIsSurfaced() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(meetingInvitationResponseReceivedMessage = MeetingInvitationResponseReceivedMessage(accepted = true, responderName = "Ada")))
            waitFor { conn.state.inviteOutcome.value != null }
            assertEquals(InviteOutcome.Accepted("Ada"), conn.state.inviteOutcome.value)

            live.push(ServerToClientMessage(meetingInvitationResponseReceivedMessage = MeetingInvitationResponseReceivedMessage(accepted = false, responderName = "Cy")))
            waitFor { conn.state.inviteOutcome.value == InviteOutcome.Declined("Cy") }

            live.push(ServerToClientMessage(meetingInvitationRequestTooHighMessage = MeetingInvitationRequestTooHighMessage()))
            waitFor { conn.state.inviteOutcome.value == InviteOutcome.TooMany }
            conn.close()
        }
    }

    @Test
    fun locateReturnsThePositionTheServerAnswersWith() = runBlocking<Unit> {
        val live = LiveFake { ws, msg ->
            val ask = msg.askPositionMessage
            if (ask != null && ask.askType == AskPositionMessage.AskType.LOCATE) {
                ws.send(Envelope.wrap(1, ServerToClientMessage.ADAPTER.encode(ServerToClientMessage(
                    locatePositionMessage = LocatePositionMessage(position = PositionMessage(x = 1234, y = 567), userId = 9, userUuid = ask.userIdentifier),
                ))).toByteString())
            }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(Pt(1234.0, 567.0), conn.locate("uuid-bob", "https://play/room"))
            val ask = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }
                .first { it.askPositionMessage != null }.askPositionMessage!!
            assertEquals("uuid-bob", ask.userIdentifier)
            assertEquals("https://play/room", ask.playUri)
            conn.close()
        }
    }

    @Test
    fun locateGivesUpWhenTheServerNeverAnswers() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertNull(conn.locate("uuid-nobody", "u", timeoutMs = 300))
            conn.close()
        }
    }

    // The older locate's cleanup used to remove whatever was stored under the uuid, i.e. the NEWER locate's entry, so
    // the server's reply for it was dropped (seen as an accepted invite whose walk silently never started).
    @Test
    fun cancellingAnOlderLocateDoesNotDropTheNewerOnesAnswer() = runBlocking<Unit> {
        val asks = java.util.concurrent.atomic.AtomicInteger()
        val release = java.util.concurrent.CountDownLatch(1)
        val live = LiveFake { ws, msg ->
            val ask = msg.askPositionMessage
            if (ask != null && ask.askType == AskPositionMessage.AskType.LOCATE && asks.incrementAndGet() == 2) {
                release.await(5, TimeUnit.SECONDS)
                ws.send(Envelope.wrap(1, ServerToClientMessage.ADAPTER.encode(ServerToClientMessage(
                    locatePositionMessage = LocatePositionMessage(position = PositionMessage(x = 10, y = 20), userId = 9, userUuid = ask.userIdentifier),
                ))).toByteString())
            }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val older = launch(Dispatchers.IO) { conn.locate("uuid-bob", "u", timeoutMs = 10_000) }
            waitFor { asks.get() == 1 }
            val newer = async(Dispatchers.IO) { conn.locate("uuid-bob", "u", timeoutMs = 4_000) }
            waitFor { asks.get() == 2 }
            older.cancelAndJoin()
            release.countDown()
            assertEquals(Pt(10.0, 20.0), newer.await())
            conn.close()
        }
    }
}
