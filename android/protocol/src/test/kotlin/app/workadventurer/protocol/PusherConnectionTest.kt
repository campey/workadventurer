package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.nav.Pt
import app.workadventurer.proto.AnswerMessage
import app.workadventurer.proto.AskPositionMessage
import app.workadventurer.proto.BatchMessage
import app.workadventurer.proto.ErrorMessage
import app.workadventurer.proto.FilterType
import app.workadventurer.proto.IceServer
import app.workadventurer.proto.IceServersAnswer
import app.workadventurer.proto.IceServersQuery
import app.workadventurer.proto.JoinSpaceAnswer
import app.workadventurer.proto.JoinSpaceQuery
import app.workadventurer.proto.JoinSpaceRequestMessage
import app.workadventurer.proto.LeaveSpaceRequestMessage
import app.workadventurer.proto.MuteAudioPrivateMessage
import app.workadventurer.proto.PrivateEventPusherToFront
import app.workadventurer.proto.PrivateSpaceEvent
import app.workadventurer.proto.QueryMessage
import app.workadventurer.proto.SpaceUser
import app.workadventurer.proto.WebRtcDisconnectMessage
import app.workadventurer.proto.WebRtcSignal
import app.workadventurer.proto.WebRtcStartMessage
import app.workadventurer.proto.CharacterTextureMessage
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
import kotlin.test.assertNotEquals
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

    // Issue #77: the Users screen wants to know about far-away bubbles, so how much of the map we ask the server for is a setting.
    @Test
    fun theViewportWeAskForFollowsTheConfig() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 7))))
            },
        )
        server(fake).use { s ->
            val big = cfg(s).copy(viewportHalfWidth = 6000, viewportHalfHeight = 4000)
            val conn = PusherConnection(OkHttpClient(), big, keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val join = generateSequence { fake.received.poll(2, TimeUnit.SECONDS) }.first { it.joinRoomFrontMessage != null }.joinRoomFrontMessage!!
            val v = join.viewportMessage!!
            assertEquals(6000 + 320, v.right) // centred on the spawn fallback (320, 320)
            assertEquals(4000 + 320, v.bottom)
            assertEquals(0, v.left) // never negative
            conn.close()
        }
    }

    @Test
    // Measured on prod (afrolabs, 2026-10-09): from spawn, +-1920x1080 saw 0-2 players and no far bubble; +-6000x4000 and
    // +-10000x8000 saw the far bubble too. So we ask for a whole map's worth (the biggest maps are ~6400x3840 px).
    fun theDefaultViewportCoversAWholeMap() = runBlocking {
        assertEquals(8000, RoomConfig(name = "x").viewportHalfWidth)
        assertEquals(6000, RoomConfig(name = "x").viewportHalfHeight)
    }

    // Issue #77: our own woka picture comes from the server's room-joined message, so no extra request is needed.
    @Test
    fun theRoomJoinedMessageGivesUsOurOwnWokaTextures() = runBlocking {
        val fake = Fake(
            onOpen = { ws -> ws.send(s2c(ServerToClientMessage(roomConnectedMessage = RoomConnectedMessage()))) },
            onFrame = { ws, msg ->
                if (msg.joinRoomFrontMessage != null) {
                    ws.send(s2c(ServerToClientMessage(roomJoinedMessage = RoomJoinedMessage(currentUserId = 7,
                        characterTextures = listOf(CharacterTextureMessage(url = "https://x/full.png", id = "woka1"))))))
                }
            },
        )
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(listOf(Texture("woka1", "https://x/full.png")), conn.state.myTextures.value)
            conn.close()
        }
    }

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
    private fun serverWithMap(fake: Fake, tmj: String?, tmjRequests: AtomicInteger = AtomicInteger(), areasJson: String = "[]"): MockWebServer {
        val s = MockWebServer()
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val base = s.url("/").toString().trimEnd('/')
                return when {
                    request.path!!.startsWith("/anonymLogin") -> MockResponse().setBody("""{"authToken":"TOK","userUuid":"me"}""")
                    request.path!!.startsWith("/map") -> MockResponse().setBody("""{"wamUrl":"$base/the.wam"}""")
                    request.path == "/the.wam" -> MockResponse().setBody("""{"mapUrl":"$base/the.tmj","entities":{},"areas":$areasJson}""")
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
            val logs = java.util.concurrent.CopyOnWriteArrayList<String>()
            val collector = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { conn.log.collect { logs += it } }
            withTimeout(5_000) { conn.connect() }
            assertEquals(7, conn.state.myUserId.value)
            // wait for the loader to actually give up, rather than a fixed sleep that a slow load would outlast
            withTimeout(5_000) { while (logs.none { it.contains("nav grid unavailable") }) delay(10) }
            assertNull(conn.grid.value)
            collector.cancel()
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

    // The keepalive repeats our position; mid-walk it must say we're still moving, or peers see the walking animation
    // stop every few seconds.
    @Test
    fun theKeepAliveDoesNotClaimWeStoppedWhileWeAreStillWalking() = runBlocking<Unit> {
        val fake = joiningFake()
        server(fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 50)
            withTimeout(5_000) { conn.connect() }
            conn.move(10.0, 10.0, Facing.RIGHT, true)
            delay(400)
            val sent = mutableListOf<ClientToServerMessage>()
            fake.received.drainTo(sent)
            val moves = sent.mapNotNull { it.userMovesMessage }
            assertTrue(moves.size > 2, "expected keepalives, got ${moves.size}")
            assertTrue(moves.all { it.position!!.moving }, "a keepalive said moving=false mid-walk")
            conn.move(10.0, 10.0, Facing.RIGHT, false)
            delay(300)
            sent.clear(); fake.received.drainTo(sent)
            assertEquals(false, sent.mapNotNull { it.userMovesMessage }.last().position!!.moving)
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

    @Test
    fun aQueryResolvesWithTheAnswerThatCarriesItsId() = runBlocking<Unit> {
        val live = LiveFake { ws, msg ->
            msg.queryMessage?.let { q ->
                ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "sp_${q.id}")))))
            }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val a = conn.query { id -> QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(spaceName = "a")) }
            val b = conn.query { id -> QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(spaceName = "b")) }
            assertNotEquals(a.id, b.id)
            assertEquals("sp_${a.id}", a.joinSpaceAnswer!!.spaceUserId)
            conn.close()
        }
    }

    @Test
    fun aServerErrorAnswerFailsTheQuery() = runBlocking<Unit> {
        val live = LiveFake { ws, msg ->
            msg.queryMessage?.let { q -> ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, error = ErrorMessage(message = "nope"))))) }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            val e = assertFailsWith<QueryFailed> { conn.query { id -> QueryMessage(id = id, iceServersQuery = IceServersQuery()) } }
            assertEquals("nope", e.message)
            conn.close()
        }
    }

    // Review Focus 6: a query nobody answers times out, and its late answer must not disturb the next query.
    @Test
    fun anUnansweredQueryTimesOutAndALateAnswerIsHarmless() = runBlocking<Unit> {
        val seen = AtomicInteger()
        val live = LiveFake { ws, msg ->
            msg.queryMessage?.let { q ->
                if (seen.incrementAndGet() > 1) ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "ok")))))
                else Thread { Thread.sleep(500); ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "late"))))) }.start()
            }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertFailsWith<QueryTimeout> { // a plain exception, NOT a CancellationException (see the next test)
                conn.query(timeoutMs = 200) { id -> QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(spaceName = "x")) }
            }
            delay(700) // the late answer for the first query arrives now
            assertEquals("ok", conn.query { id -> QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(spaceName = "y")) }.joinSpaceAnswer!!.spaceUserId)
            conn.close()
        }
    }

    // Final review, Critical: a timed-out query used to surface as a CancellationException, which iceServers() rethrew, so the
    // voice host's ICE-servers task was silently cancelled and every later voice event was dropped until the next reconnect.
    @Test
    fun anIceServersQueryTheServerNeverAnswersFallsBackToStunInsteadOfCancelling() = runBlocking<Unit> {
        val live = LiveFake() // never answers queries
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null)), conn.iceServers(timeoutMs = 200))
            conn.close()
        }
    }

    // A room whose .wam has no start area (the campus map): the join must carry a tile of the map's "start" layer, not the
    // fixed (320,320) fallback, or the avatar lands in a corner, sees nobody, and has no route to anyone.
    @Test
    fun aRoomWithOnlyATileStartLayerJoinsOnThatTile() = runBlocking<Unit> {
        val start = (0 until 144).joinToString(",") { if (it == 3 * 12 + 5) "9" else "0" }
        val zeros = (0 until 144).joinToString(",") { "0" }
        val tmj = """{"width":12,"height":12,"tilewidth":32,"tilesets":[],"layers":[
            {"type":"tilelayer","name":"start","data":[$start]},{"type":"tilelayer","name":"collisions","data":[$zeros]}]}"""
        val fake = joiningFake()
        serverWithMap(fake, tmj).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(10_000) { conn.connect() }
            val pos = generateSequence { fake.received.poll(2, TimeUnit.SECONDS) }.first { it.joinRoomFrontMessage != null }
                .joinRoomFrontMessage!!.positionMessage!!
            assertEquals(5 * 32 + 16, pos.x); assertEquals(3 * 32 + 16, pos.y)
            withTimeout(5_000) { while (conn.grid.value == null) delay(10) } // let the background map load finish before the server closes
            conn.close()
        }
    }

    private fun spaceFake(onLeaveQuery: () -> Unit = {}) = LiveFake { ws, msg ->
        msg.queryMessage?.let { q ->
            when {
                q.joinSpaceQuery != null -> ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "${q.joinSpaceQuery!!.spaceName}_7")))))
                q.leaveSpaceQuery != null -> onLeaveQuery()
            }
        }
    }

    @Test
    fun aJoinSpaceRequestJoinsWithTheAdapterValuesThenWatchesTheSpace() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "open-space_bubble1")))
            waitFor { conn.state.spaces.value.containsKey("open-space_bubble1") }
            assertEquals("open-space_bubble1_7", conn.state.spaces.value["open-space_bubble1"])
            val sent = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }.take(40).toList()
            val join = sent.mapNotNull { it.queryMessage?.joinSpaceQuery }.single()
            assertEquals(FilterType.ALL_USERS, join.filterType)
            assertEquals(listOf("cameraState", "microphoneState", "screenSharingState"), join.propertiesToSync)
            assertEquals("open-space_bubble1", sent.mapNotNull { it.addSpaceFilterMessage }.single().spaceFilterMessage!!.spaceName)
            conn.close()
        }
    }

    @Test
    fun theServersOwnPropertiesToSyncWinOverTheDefaults() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp", propertiesToSync = listOf("microphoneState"))))
            waitFor { conn.state.spaces.value.containsKey("sp") }
            val join = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }.take(40).mapNotNull { it.queryMessage?.joinSpaceQuery }.first()
            assertEquals(listOf("microphoneState"), join.propertiesToSync)
            conn.close()
        }
    }

    // Review Focus 7: a second join request for a space we are in, and a leave for one we never joined, are harmless.
    @Test
    fun repeatedJoinsAndUnknownLeavesAreHarmless() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.containsKey("sp") }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "never")))
            delay(300)
            val sent = generateSequence { live.fake.received.poll(300, TimeUnit.MILLISECONDS) }.toList()
            assertEquals(1, sent.count { it.queryMessage?.joinSpaceQuery != null })
            assertEquals(0, sent.count { it.removeSpaceFilterMessage != null })
            assertEquals(setOf("sp"), conn.state.spaces.value.keys)
            conn.close()
        }
    }

    @Test
    fun aLeaveSpaceRequestUnwatchesAndLeaves() = runBlocking<Unit> {
        val left = java.util.concurrent.CountDownLatch(1)
        val live = spaceFake { left.countDown() }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.containsKey("sp") }
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.isEmpty() }
            assertTrue(left.await(3, TimeUnit.SECONDS), "leaveSpaceQuery never sent")
            val sent = generateSequence { live.fake.received.poll(300, TimeUnit.MILLISECONDS) }.toList()
            assertEquals("sp", sent.mapNotNull { it.removeSpaceFilterMessage }.single().spaceFilterMessage!!.spaceName)
            conn.close()
        }
    }

    /** Every updateSpaceUserMessage the client sent within [windowMs], as (spaceName, spaceUserId, microphoneState, maskPaths). */
    private fun micUpdates(live: LiveFake, windowMs: Long = 600): List<List<Any?>> =
        generateSequence { live.fake.received.poll(windowMs, TimeUnit.MILLISECONDS) }
            .mapNotNull { it.updateSpaceUserMessage }
            .map { listOf(it.spaceName, it.user?.spaceUserId, it.user?.microphoneState, it.updateMask?.paths) }.toList()

    private suspend fun joined(live: LiveFake, conn: PusherConnection, space: String = "sp") {
        live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = space)))
        waitFor { conn.state.spaces.value.containsKey(space) }
    }

    @Test
    fun turningTheMicOnInASpaceAnnouncesItAtOnceWithTheRightMask() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L, 100L, 300L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn)
            conn.setMicOn(true)
            val sent = micUpdates(live, 800)
            assertEquals(listOf("sp", "sp_7", true, listOf("microphoneState")), sent.first())
            assertEquals(3, sent.count { it[2] == true }, "0, 100 and 300 ms announcements: $sent")
            conn.close()
        }
    }

    @Test
    fun joiningASpaceWhileTheMicIsOnAnnouncesAndWhileOffDoesNot() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L, 100L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn, "off")
            assertTrue(micUpdates(live, 500).isEmpty(), "announced while the mic was off")
            conn.setMicOn(true); micUpdates(live, 400)
            joined(live, conn, "on")
            val sent = micUpdates(live, 600)
            assertEquals(listOf("on", "on"), sent.filter { it[0] == "on" }.map { it[0] }, "announced at join and once more: $sent")
            conn.close()
        }
    }

    // Review Focus 2
    @Test
    fun mutingAnnouncesOffAtOnceAndStopsPendingOnAnnouncements() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L, 400L, 800L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn)
            conn.setMicOn(true)
            delay(100)
            conn.setMicOn(false)
            val sent = micUpdates(live, 1_500)
            assertEquals(false, sent.last()[2], "the last word must be mic-off: $sent")
            assertEquals(1, sent.count { it[2] == true }, "an 'on' timer fired after the mute: $sent")
            conn.close()
        }
    }

    // Review Focus 1
    @Test
    fun leavingASpaceStopsItsAnnouncementsAndAnUnknownSpaceIsNeverAnnounced() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L, 400L, 800L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn)
            conn.setMicOn(true)
            delay(100)
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.isEmpty() }
            val sent = micUpdates(live, 1_500)
            assertEquals(1, sent.count { it[0] == "sp" }, "announced after leaving: $sent")
            conn.setMicOn(false); conn.setMicOn(true) // no spaces now: nothing to announce
            assertTrue(micUpdates(live, 400).isEmpty())
            conn.close()
        }
    }

    @Test
    fun theServersSpaceUserListReannouncesWhileTheMicIsOn() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, micReannounceMs = listOf(0L))
            withTimeout(5_000) { conn.connect() }
            joined(live, conn)
            conn.setMicOn(true); micUpdates(live, 300)
            live.push(batch(SubMessage(initSpaceUsersMessage = app.workadventurer.proto.InitSpaceUsersMessage(spaceName = "sp"))))
            assertEquals(1, micUpdates(live, 600).count { it[2] == true })
            conn.setMicOn(false); micUpdates(live, 300)
            live.push(batch(SubMessage(initSpaceUsersMessage = app.workadventurer.proto.InitSpaceUsersMessage(spaceName = "sp"))))
            assertTrue(micUpdates(live, 400).isEmpty(), "re-announced while the mic was off")
            conn.close()
        }
    }

    // Final review (raised to Important: once the mic exists this would mean speaking into a bubble we were told to leave): a
    // leave that arrives right behind a still-pending join must run AFTER it, not get overtaken and no-op.
    @Test
    fun aLeaveRightBehindASlowJoinLeavesTheSpaceAfterJoiningIt() = runBlocking<Unit> {
        val live = LiveFake { ws, msg ->
            msg.queryMessage?.let { q ->
                if (q.joinSpaceQuery != null) Thread {
                    Thread.sleep(300)
                    ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, joinSpaceAnswer = JoinSpaceAnswer(spaceUserId = "sp_7")))))
                }.start()
            }
        }
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "sp")))
            val sent = mutableListOf<ClientToServerMessage>()
            withTimeout(5_000) {
                while (sent.none { it.removeSpaceFilterMessage != null }) { live.fake.received.poll(100, TimeUnit.MILLISECONDS)?.let { sent += it } }
            }
            val add = sent.indexOfFirst { it.addSpaceFilterMessage != null }
            val remove = sent.indexOfFirst { it.removeSpaceFilterMessage != null }
            assertTrue(add in 0 until remove, "the space must be watched, then unwatched (add=$add, remove=$remove)")
            assertTrue(conn.state.spaces.value.isEmpty(), "still a member of a space we were told to leave")
            conn.close()
        }
    }

    // Meeting-room areas: the server never invites a headless client to one the way it does for proximity bubbles, so the client
    // must join the area's space itself when it dwells inside (the phone only ever joined bubbles).
    private val fireAreas = """[{"id":"a1","name":"Fire pit","x":1000,"y":1000,"width":200,"height":200,
        "properties":[{"id":"p1","type":"livekitRoomProperty","roomName":"Fire pit"}]}]"""

    @Test
    fun dwellingInAMeetingAreaJoinsItsSpaceAndLeavingItLeavesAfterTheLinger() = runBlocking<Unit> {
        val live = spaceFake()
        serverWithMap(live.fake, tmj = null, areasJson = fireAreas).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, meetingDwellMs = 200, meetingLingerMs = 300)
            withTimeout(10_000) { conn.connect() }
            assertTrue(conn.state.spaces.value.isEmpty(), "the fallback spawn is outside the area")
            conn.move(1100.0, 1100.0, Facing.DOWN, false)
            waitFor { conn.state.spaces.value.containsKey("9ida9r-fire-pit") } // shortHash(room url) + room name, as the web client names it
            conn.move(0.0, 0.0, Facing.DOWN, false)
            waitFor { conn.state.spaces.value.isEmpty() }
            conn.close()
        }
    }

    @Test
    fun walkingThroughAMeetingAreaWithoutDwellingJoinsNothing() = runBlocking<Unit> {
        val live = spaceFake()
        serverWithMap(live.fake, tmj = null, areasJson = fireAreas).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000, meetingDwellMs = 600, meetingLingerMs = 300)
            withTimeout(10_000) { conn.connect() }
            conn.move(1100.0, 1100.0, Facing.DOWN, false)
            delay(100)
            conn.move(0.0, 0.0, Facing.DOWN, false)
            delay(1_000)
            assertTrue(conn.state.spaces.value.isEmpty())
            val sent = generateSequence { live.fake.received.poll(200, TimeUnit.MILLISECONDS) }.toList()
            assertEquals(0, sent.count { it.queryMessage?.joinSpaceQuery != null }, "joined a space we only walked through")
            conn.close()
        }
    }

    private fun batch(vararg subs: SubMessage) = ServerToClientMessage(batchMessage = BatchMessage(payload = subs.toList()))
    private fun privateEvent(sender: String, ev: PrivateSpaceEvent) = SubMessage(privateEvent = PrivateEventPusherToFront(
        spaceName = "sp", receiverUserId = "me", sender = SpaceUser(spaceUserId = sender), spaceEvent = ev))

    @Test
    fun webRtcPrivateEventsBecomeVoiceEvents() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            val events = java.util.concurrent.CopyOnWriteArrayList<VoiceEvent>()
            val collector = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { conn.voiceEvents.collect { events += it } }
            withTimeout(5_000) { conn.connect() }
            live.push(batch(
                privateEvent("sp_9", PrivateSpaceEvent(webRtcStartMessage = WebRtcStartMessage(userId = "x", initiator = false, connectionId = "c1"))),
                privateEvent("sp_9", PrivateSpaceEvent(webRtcSignal = WebRtcSignal(signal = "{\"type\":\"offer\"}", connectionId = "c1"))),
                privateEvent("sp_9", PrivateSpaceEvent(webRtcDisconnectMessage = WebRtcDisconnectMessage(userId = "x"))),
            ))
            waitFor { events.size == 3 }
            assertEquals(VoiceEvent.Start("sp", "sp_9", "c1", false), events[0])
            assertEquals(VoiceEvent.Signal("sp", "sp_9", "c1", "{\"type\":\"offer\"}"), events[1])
            assertEquals(VoiceEvent.Disconnect("sp", "sp_9"), events[2])
            collector.cancel(); conn.close()
        }
    }

    @Test
    fun otherPrivateEventsAreIgnoredAndLeavingASpaceEmitsSpaceLeft() = runBlocking<Unit> {
        val live = spaceFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            val events = java.util.concurrent.CopyOnWriteArrayList<VoiceEvent>()
            val collector = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { conn.voiceEvents.collect { events += it } }
            withTimeout(5_000) { conn.connect() }
            live.push(batch(privateEvent("sp_9", PrivateSpaceEvent(muteAudio = MuteAudioPrivateMessage()))))
            live.push(ServerToClientMessage(joinSpaceRequestMessage = JoinSpaceRequestMessage(spaceName = "sp")))
            waitFor { conn.state.spaces.value.containsKey("sp") }
            live.push(ServerToClientMessage(leaveSpaceRequestMessage = LeaveSpaceRequestMessage(spaceName = "sp")))
            waitFor { events.isNotEmpty() }
            assertEquals(listOf<VoiceEvent>(VoiceEvent.SpaceLeft("sp")), events.toList())
            collector.cancel(); conn.close()
        }
    }

    @Test
    fun sendSignalAddressesTheRightPeerAndConnection() = runBlocking<Unit> {
        val live = LiveFake()
        server(live.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            conn.sendSignal("sp", "sp_9", "c1", "{\"type\":\"answer\",\"sdp\":\"x\"}")
            val pe = generateSequence { live.fake.received.poll(2, TimeUnit.SECONDS) }.first { it.privateEvent != null }.privateEvent!!
            assertEquals("sp", pe.spaceName); assertEquals("sp_9", pe.receiverUserId)
            assertEquals("c1", pe.spaceEvent!!.webRtcSignal!!.connectionId)
            assertEquals("{\"type\":\"answer\",\"sdp\":\"x\"}", pe.spaceEvent!!.webRtcSignal!!.signal)
            conn.close()
        }
    }

    @Test
    fun iceServersComeFromTheServerAndFallBackToStunWhenItFails() = runBlocking<Unit> {
        val ok = LiveFake { ws, msg ->
            msg.queryMessage?.let { q ->
                if (q.iceServersQuery != null) ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id,
                    iceServersAnswer = IceServersAnswer(iceServers = listOf(IceServer(urls = listOf("turn:t.example:3478"), username = "u", credential = "c")))))))
            }
        }
        server(ok.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(listOf(IceServerInfo(listOf("turn:t.example:3478"), "u", "c")), conn.iceServers())
            conn.close()
        }
        val bad = LiveFake { ws, msg ->
            msg.queryMessage?.let { q -> ws.send(s2c(ServerToClientMessage(answerMessage = AnswerMessage(id = q.id, error = ErrorMessage(message = "no"))))) }
        }
        server(bad.fake).use { s ->
            val conn = PusherConnection(OkHttpClient(), cfg(s), keepAliveMs = 60_000)
            withTimeout(5_000) { conn.connect() }
            assertEquals(listOf(IceServerInfo(listOf("stun:stun.l.google.com:19302"), null, null)), conn.iceServers())
            conn.close()
        }
    }
}
