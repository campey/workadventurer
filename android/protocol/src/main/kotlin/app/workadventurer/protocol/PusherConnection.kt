package app.workadventurer.protocol

import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.JoinRoomFrontMessage
import app.workadventurer.proto.PingMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.ServerToClientMessage
import app.workadventurer.proto.UserMovesMessage
import app.workadventurer.proto.ViewportMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

class JoinFailed(message: String) : Exception(message)
data class Closed(val code: Int, val reason: String)

/**
 * One live pusher socket for one room. Mirrors WorkAdventureClient.connect/_handle/_startKeepAlive.
 * `open` so WaSession tests can substitute a fake without real I/O.
 */
open class PusherConnection(
    private val http: OkHttpClient,
    private val cfg: RoomConfig,
    val state: RoomState = RoomState(),
    private val keepAliveMs: Long = 5_000,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val seq = AtomicLong(1)
    private val joined = CompletableDeferred<Unit>()
    private val _closed = CompletableDeferred<Closed>()
    private val _log = MutableSharedFlow<String>(extraBufferCapacity = 64)
    private var ws: WebSocket? = null
    private var keepAlive: Job? = null
    private var spawn = Spawn(320, 320, null)

    /** Completes when the socket closes or fails, before or after join. */
    open val closed: Deferred<Closed> get() = _closed
    open val log: SharedFlow<String> get() = _log.asSharedFlow()

    /** login -> areas -> spawn -> websocket; returns after roomJoinedMessage, throws [JoinFailed]. */
    open suspend fun connect() {
        val login = anonymLogin(http, cfg)
        _log.tryEmit("anonymLogin ok (uuid ${login.userUuid})")
        val areas = loadAreas(http, cfg)
        state.areas = areas
        spawn = pickSpawn(areas)
        state.setMyPosition(spawn.x, spawn.y)
        _log.tryEmit("loaded ${areas.size} map areas; spawn ${spawn.x},${spawn.y}${spawn.area?.let { " in \"$it\"" } ?: ""}")

        val req = Request.Builder()
            .url(wsUrl(cfg, UUID.randomUUID().toString().take(12)))
            .header("Sec-WebSocket-Protocol", login.authToken) // JWT rides as the subprotocol
            .header("Origin", "https://play.workadventu.re")
            .build()
        ws = http.newWebSocket(req, listener)
        joined.await()
    }

    open fun close() {
        keepAlive?.cancel()
        ws?.close(1000, "bye")
        scope.cancel()
    }

    private fun send(m: ClientToServerMessage) {
        ws?.send(Envelope.wrap(seq.getAndIncrement(), ClientToServerMessage.ADAPTER.encode(m)).toByteString())
    }

    private fun viewport(): ViewportMessage {
        val (x, y) = state.myPosition()
        return ViewportMessage(
            left = maxOf(0, x - 1920), top = maxOf(0, y - 1080), right = x + 1920, bottom = y + 1080,
        )
    }

    private fun position(moving: Boolean): PositionMessage {
        val (x, y) = state.myPosition()
        return PositionMessage(x = x, y = y, direction = PositionMessage.Direction.DOWN, moving = moving)
    }

    private fun fail(reason: String) {
        if (!joined.isCompleted) joined.completeExceptionally(JoinFailed(reason))
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            _log.tryEmit("socket open; waiting for roomConnectedMessage")
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val payloads = try { Envelope.unwrap(bytes.toByteArray()) } catch (e: Exception) {
                _log.tryEmit("unwrap error: ${e.message}"); return
            }
            for (p in payloads) {
                val msg = try { ServerToClientMessage.ADAPTER.decode(p) } catch (e: Exception) {
                    _log.tryEmit("decode error: ${e.message}"); continue
                }
                handle(msg)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(code, reason)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            finish(response?.code ?: -1, t.message ?: t.javaClass.simpleName)
    }

    private fun finish(code: Int, reason: String) {
        keepAlive?.cancel()
        fail("closed before join: $code $reason")
        _closed.complete(Closed(code, reason))
    }

    private fun handle(m: ServerToClientMessage) {
        m.batchMessage?.let { b ->
            for (sub in b.payload) {
                if (sub.pingMessage != null) send(ClientToServerMessage(pingMessage = PingMessage()))
                else state.applySub(sub)
            }
            return
        }
        if (m.roomConnectedMessage != null) {
            _log.tryEmit("roomConnectedMessage received; sending joinRoomFrontMessage")
            send(ClientToServerMessage(joinRoomFrontMessage = JoinRoomFrontMessage(
                name = cfg.name,
                positionMessage = position(false),
                viewportMessage = viewport(),
                availabilityStatus = AvailabilityStatus.ONLINE,
            )))
            return
        }
        m.roomJoinedMessage?.let { r ->
            state.setMyUserId(r.currentUserId)
            _log.tryEmit("joined room as userId ${r.currentUserId}")
            startKeepAlive()
            joined.complete(Unit)
            return
        }
        m.errorScreenMessage?.let { fail("server error screen: ${it.title} / ${it.details}"); return }
        if (m.invalidCharacterTextureMessage != null) { fail("invalid character texture"); return }
        if (m.tokenExpiredMessage != null) { fail("token expired"); return }
        m.errorMessage?.let { _log.tryEmit("errorMessage: ${it.message}") }
    }

    private fun startKeepAlive() {
        keepAlive?.cancel()
        keepAlive = scope.launch {
            while (true) {
                delay(keepAliveMs)
                send(ClientToServerMessage(userMovesMessage = UserMovesMessage(position = position(false), viewport = viewport())))
            }
        }
    }
}
