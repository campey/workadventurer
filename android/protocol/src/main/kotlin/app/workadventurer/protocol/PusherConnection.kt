package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.nav.MovementSink
import app.workadventurer.nav.NavGrid
import app.workadventurer.nav.Pt
import app.workadventurer.proto.AskPositionMessage
import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.JoinRoomFrontMessage
import app.workadventurer.proto.MeetingInvitationRequestMessage
import app.workadventurer.proto.MeetingInvitationResponseMessage
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
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
    private val joinTimeoutMs: Long = 20_000,
    private val cacheDir: File? = null,
) : MovementSink {
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

    private val _grid = MutableStateFlow<NavGrid?>(null)

    /** The room's collision grid: null until the background load finishes (and forever if it fails). */
    open val grid: StateFlow<NavGrid?> get() = _grid.asStateFlow()

    override fun position(): Pt = state.myPose.value.let { Pt(it.x, it.y) }

    override fun move(x: Double, y: Double, facing: Facing, moving: Boolean) {
        state.setMyPose(x, y, facing)
        send(ClientToServerMessage(userMovesMessage = UserMovesMessage(position = positionMessage(moving), viewport = viewport())))
    }

    /** "Invite to discussion": ask [receiverUuid] to come over. The outcome arrives in [RoomState.inviteOutcome]. */
    open fun sendInvite(receiverUuid: String, receiverUserId: Int?) {
        // never log the uuid: for logged-in players it is their account email address
        _log.tryEmit("inviting user id $receiverUserId")
        send(ClientToServerMessage(meetingInvitationRequestMessage = MeetingInvitationRequestMessage(
            receiverUserUuid = receiverUuid, receiverUserId = receiverUserId,
        )))
    }

    /** Accept or decline an invitation from [senderUuid]; either way it is no longer pending. */
    open fun respondToInvite(senderUuid: String, accept: Boolean) {
        val who = state.pendingInvites.value.firstOrNull { it.senderUuid == senderUuid }?.senderName ?: "?"
        _log.tryEmit("answering invitation from $who: ${if (accept) "accept" else "decline"}")
        send(ClientToServerMessage(meetingInvitationResponseMessage = MeetingInvitationResponseMessage(
            accept = accept, requestSenderUserUuid = senderUuid,
        )))
        state.removeInvite(senderUuid)
    }

    private val pendingLocates = ConcurrentHashMap<String, CompletableDeferred<Pt>>()

    /**
     * Where is the player [uuid]? Works for players outside our viewport (the server only streams nearby players).
     * Null if the server doesn't answer within [timeoutMs].
     */
    open suspend fun locate(uuid: String, playUri: String, timeoutMs: Long = 5_000): Pt? {
        val answer = CompletableDeferred<Pt>()
        pendingLocates[uuid] = answer
        send(ClientToServerMessage(askPositionMessage = AskPositionMessage(
            userIdentifier = uuid, playUri = playUri, askType = AskPositionMessage.AskType.LOCATE,
        )))
        return try {
            withTimeoutOrNull(timeoutMs) { answer.await() }
        } finally {
            pendingLocates.remove(uuid)
        }
    }

    private fun nudgeOffBlockedTile(g: NavGrid) {
        val p = position()
        if (!g.isPxBlocked(p.x, p.y)) return
        val (tx, ty) = g.pxToTile(p.x, p.y)
        val free = g.nearestFree(tx, ty) ?: return
        val c = g.tileCenterPx(free.first, free.second)
        _log.tryEmit("spawn tile is blocked; nudged to ${c.x.toInt()},${c.y.toInt()}")
        move(c.x, c.y, state.myPose.value.facing, false)
    }

    /** login -> areas -> spawn -> websocket; returns after roomJoinedMessage, throws [JoinFailed]. */
    open suspend fun connect() {
        // Any failure here (rejection, timeout, cancellation by a Leave) must not leave a half-open socket
        // behind: an open socket keeps an avatar in the room and, with pings, stays alive indefinitely.
        try {
            val login = anonymLogin(http, cfg)
            _log.tryEmit("anonymLogin ok")
            val wam = fetchWamJson(http, cfg)
            val areas = wam?.let { try { parseWam(it) } catch (e: Exception) { emptyList() } }.orEmpty()
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
            // A server that accepts the upgrade but never answers would otherwise hang us on "Connecting…".
            withTimeoutOrNull(joinTimeoutMs) { joined.await() }
                ?: throw JoinFailed("timed out waiting for roomJoinedMessage")

            // The ~1.5 MB map must never delay joining, so the collision grid loads in the background; until it
            // arrives (or forever, if it fails) movement is straight-line.
            wam?.let { text ->
                scope.launch {
                    val g = loadNavGrid(http, text, cacheDir)
                    if (g == null) {
                        _log.tryEmit("nav grid unavailable; movement stays straight-line")
                    } else {
                        _grid.value = g
                        _log.tryEmit("nav grid ready (${g.w}x${g.h})")
                        nudgeOffBlockedTile(g)
                    }
                }
            }
        } catch (t: Throwable) {
            close()
            throw t
        }
    }

    /** Idempotent. Completes [closed] right away rather than waiting for the server to echo the close. */
    open fun close() {
        keepAlive?.cancel()
        ws?.close(1000, "bye")
        _closed.complete(Closed(1000, "closed by client"))
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

    private fun positionMessage(moving: Boolean): PositionMessage {
        val (x, y) = state.myPosition()
        return PositionMessage(x = x, y = y, direction = state.myPose.value.facing.toDirection(), moving = moving)
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
                positionMessage = positionMessage(false),
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
        m.meetingInvitationRequestReceivedMessage?.let {
            state.addInvite(Invite(it.senderUserUuid, it.senderName, it.senderUserId, it.senderPlayUri))
            _log.tryEmit("invited by ${it.senderName}")
            return
        }
        if (m.meetingInvitationRequestClosedMessage != null) {
            _log.tryEmit("invitation closed by the server (${state.pendingInvites.value.size} pending cleared)")
            state.clearInvites()
            return
        }
        m.meetingInvitationResponseReceivedMessage?.let {
            _log.tryEmit("${it.responderName} ${if (it.accepted) "accepted" else "declined"} our invitation")
            state.setInviteOutcome(if (it.accepted) InviteOutcome.Accepted(it.responderName) else InviteOutcome.Declined(it.responderName))
            return
        }
        if (m.meetingInvitationRequestTooHighMessage != null) {
            _log.tryEmit("invitation refused: too many invitations")
            state.setInviteOutcome(InviteOutcome.TooMany)
            return
        }
        m.locatePositionMessage?.let { loc ->
            val p = loc.position
            if (p != null) pendingLocates.remove(loc.userUuid)?.complete(Pt(p.x.toDouble(), p.y.toDouble()))
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
                send(ClientToServerMessage(userMovesMessage = UserMovesMessage(position = positionMessage(false), viewport = viewport())))
            }
        }
    }
}
