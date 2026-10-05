package app.workadventurer.protocol

import app.workadventurer.proto.BatchMessage
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.ErrorScreenMessage
import app.workadventurer.proto.PingMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.RoomConnectedMessage
import app.workadventurer.proto.RoomJoinedMessage
import app.workadventurer.proto.ServerToClientMessage
import app.workadventurer.proto.SubMessage
import app.workadventurer.proto.UserJoinedMessage
import kotlinx.coroutines.delay
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
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
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
}
