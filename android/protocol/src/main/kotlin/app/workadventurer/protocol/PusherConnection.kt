package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.nav.MovementSink
import app.workadventurer.nav.NavGrid
import app.workadventurer.nav.Pt
import app.workadventurer.proto.AddSpaceFilterMessage
import app.workadventurer.proto.AnswerMessage
import app.workadventurer.proto.AskPositionMessage
import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.FilterType
import app.workadventurer.proto.IceServersQuery
import app.workadventurer.proto.JoinSpaceQuery
import app.workadventurer.proto.LeaveSpaceQuery
import app.workadventurer.proto.RemoveSpaceFilterMessage
import app.workadventurer.proto.SpaceFilterMessage
import app.workadventurer.proto.SpaceUser
import app.workadventurer.proto.UpdateSpaceUserMessage
import app.workadventurer.proto.JoinRoomFrontMessage
import app.workadventurer.proto.MeetingInvitationRequestMessage
import app.workadventurer.proto.MeetingInvitationResponseMessage
import app.workadventurer.proto.PingMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.PrivateEventFrontToPusher
import app.workadventurer.proto.PrivateEventPusherToFront
import app.workadventurer.proto.PrivateSpaceEvent
import app.workadventurer.proto.QueryMessage
import app.workadventurer.proto.ServerToClientMessage
import app.workadventurer.proto.UserMovesMessage
import app.workadventurer.proto.ViewportMessage
import app.workadventurer.proto.WebRtcSignal
import com.google.protobuf.FieldMask
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
import java.util.concurrent.atomic.AtomicInteger
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
    private val micReannounceMs: List<Long> = listOf(0L, 1_000L, 3_000L),
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

    /** What our last position message said, so the keepalive doesn't announce a stop in the middle of a walk. */
    @Volatile private var lastMoving = false

    override fun move(x: Double, y: Double, facing: Facing, moving: Boolean) {
        lastMoving = moving
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

    private val pendingQueries = ConcurrentHashMap<Int, CompletableDeferred<AnswerMessage>>()
    private val queryIds = AtomicInteger(1)

    /** Send a query and wait for the answer that carries its id. */
    open suspend fun query(timeoutMs: Long = 10_000, build: (id: Int) -> QueryMessage): AnswerMessage {
        val id = queryIds.getAndIncrement()
        val answer = CompletableDeferred<AnswerMessage>()
        pendingQueries[id] = answer
        try {
            send(ClientToServerMessage(queryMessage = build(id)))
            val a = withTimeoutOrNull(timeoutMs) { answer.await() } ?: throw QueryTimeout("no answer to query $id within $timeoutMs ms")
            a.error?.let { throw QueryFailed(it.message) }
            return a
        } finally {
            pendingQueries.remove(id, answer)
        }
    }

    private val _voiceEvents = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 64)

    /** WebRTC start/signal/disconnect from other space members, and "we left a space". */
    open val voiceEvents: SharedFlow<VoiceEvent> get() = _voiceEvents.asSharedFlow()

    open fun sendSignal(spaceName: String, peerSpaceUserId: String, connectionId: String, signal: String) {
        send(ClientToServerMessage(privateEvent = PrivateEventFrontToPusher(
            spaceName = spaceName, receiverUserId = peerSpaceUserId,
            spaceEvent = PrivateSpaceEvent(webRtcSignal = WebRtcSignal(signal = signal, connectionId = connectionId)),
        )))
    }

    open suspend fun iceServers(timeoutMs: Long = 10_000): List<IceServerInfo> = try {
        query(timeoutMs) { id -> QueryMessage(id = id, iceServersQuery = IceServersQuery()) }
            .iceServersAnswer?.iceServers.orEmpty()
            .map { IceServerInfo(it.urls, it.username, it.credential) }
            .ifEmpty { FALLBACK_ICE }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        _log.tryEmit("iceServersQuery failed (${e.message}); using default STUN")
        FALLBACK_ICE
    }

    private fun onPrivateEvent(p: PrivateEventPusherToFront) {
        val peer = p.sender?.spaceUserId.orEmpty()
        val ev = p.spaceEvent ?: return
        ev.webRtcStartMessage?.let {
            _log.tryEmit("webRtcStart conn=${it.connectionId} initiator=${it.initiator}")
            _voiceEvents.tryEmit(VoiceEvent.Start(p.spaceName, peer, it.connectionId, it.initiator))
        }
        ev.webRtcSignal?.let { _voiceEvents.tryEmit(VoiceEvent.Signal(p.spaceName, peer, it.connectionId, it.signal)) }
        ev.webRtcDisconnectMessage?.let {
            _log.tryEmit("webRtcDisconnect from a peer in ${p.spaceName}")
            _voiceEvents.tryEmit(VoiceEvent.Disconnect(p.spaceName, peer))
        }
    }

    @Volatile var micOn = false
        private set
    private val micTimers = ConcurrentHashMap<String, Job>()

    /** Tell every space we are in whether our mic is live; while it is on, repeat the announcement (see [micReannounceMs]). */
    open fun setMicOn(on: Boolean) {
        micOn = on
        for (space in state.spaces.value.keys) if (on) scheduleMicAnnouncements(space) else { cancelMicTimer(space); announceMic(space) }
    }

    private fun announceMic(spaceName: String) {
        val mine = state.spaces.value[spaceName] ?: return // never joined, or already left
        send(ClientToServerMessage(updateSpaceUserMessage = UpdateSpaceUserMessage(
            spaceName = spaceName,
            user = SpaceUser(spaceUserId = mine, microphoneState = micOn),
            updateMask = FieldMask(paths = listOf("microphoneState")),
        )))
    }

    // A single announcement right after joining races the server registering us and the peers watching us; if it is missed
    // they treat us as muted and never play our audio (issue #10). So repeat it, but only while the mic is on.
    private fun scheduleMicAnnouncements(spaceName: String) {
        micTimers.remove(spaceName)?.cancel()
        micTimers[spaceName] = scope.launch {
            var last = 0L
            for (at in micReannounceMs) {
                delay(at - last); last = at
                if (!micOn || !state.spaces.value.containsKey(spaceName)) return@launch
                announceMic(spaceName)
            }
        }
    }

    private fun cancelMicTimer(spaceName: String) { micTimers.remove(spaceName)?.cancel() }

    private val spaceMutex = Mutex()

    private fun joinSpace(spaceName: String, props: List<String>) {
        scope.launch(start = CoroutineStart.UNDISPATCHED) { // UNDISPATCHED: take the mutex in arrival order, so a leave can never overtake a join
            spaceMutex.withLock {
                if (state.spaces.value.containsKey(spaceName)) return@launch // already a member
                try {
                    val answer = query { id ->
                        QueryMessage(id = id, joinSpaceQuery = JoinSpaceQuery(
                            spaceName = spaceName, filterType = FilterType.ALL_USERS,
                            propertiesToSync = props.ifEmpty { DEFAULT_SPACE_PROPS },
                        ))
                    }
                    state.addSpace(spaceName, answer.joinSpaceAnswer?.spaceUserId.orEmpty())
                    // "watch" the space: without this the server never sets up peer connections for us
                    send(ClientToServerMessage(addSpaceFilterMessage = AddSpaceFilterMessage(SpaceFilterMessage(spaceName = spaceName))))
                    _log.tryEmit("joined space $spaceName")
                    if (micOn) scheduleMicAnnouncements(spaceName)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _log.tryEmit("joinSpace $spaceName failed: ${e.message}")
                }
            }
        }
    }

    private fun leaveSpace(spaceName: String) {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            spaceMutex.withLock {
                if (!state.spaces.value.containsKey(spaceName)) return@launch // never joined
                state.removeSpace(spaceName)
                cancelMicTimer(spaceName)
                _voiceEvents.tryEmit(VoiceEvent.SpaceLeft(spaceName))
                send(ClientToServerMessage(removeSpaceFilterMessage = RemoveSpaceFilterMessage(SpaceFilterMessage(spaceName = spaceName))))
                _log.tryEmit("left space $spaceName")
            }
            // fire and forget: the server cleans up our membership either way
            try {
                query { id -> QueryMessage(id = id, leaveSpaceQuery = LeaveSpaceQuery(spaceName = spaceName)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) { /* ignored */ }
        }
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
            pendingLocates.remove(uuid, answer) // only our own entry: a newer locate for the same uuid may have replaced it
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
            if (areas.none { it.isStart }) {
                // No start AREA in the .wam: WorkAdventure starts players on a tile of the map's "start" layer instead. Without
                // this the avatar lands at the fixed fallback corner, sees no one, and has no route to anyone.
                wam?.let { loadMapText(http, it, cacheDir) }?.let { pickTmjSpawn(it) }?.let { spawn = it }
            }
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
                    // Anything the loader throws (even an Error from a pathological map) must leave us straight-line,
                    // not crash the app: nothing else is watching this coroutine.
                    val g = try {
                        loadNavGrid(http, text, cacheDir)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        null
                    }
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
                if (sub.pingMessage != null) {
                    send(ClientToServerMessage(pingMessage = PingMessage()))
                } else if (sub.privateEvent != null) {
                    onPrivateEvent(sub.privateEvent!!)
                } else {
                    val groupBefore = state.groupId.value
                    state.applySub(sub)
                    // the server has registered us in the space: a safe moment to (re-)announce mic-on, so nobody has us cached as muted
                    sub.initSpaceUsersMessage?.let { if (micOn && state.spaces.value.containsKey(it.spaceName)) announceMic(it.spaceName) }
                    val groupAfter = state.groupId.value
                    // so a log can answer "did the server put us in a bubble?" from the phone's side
                    if (groupAfter != groupBefore) _log.tryEmit(if (groupAfter != null) "entered bubble $groupAfter" else "left bubble")
                }
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
        m.joinSpaceRequestMessage?.let { joinSpace(it.spaceName, it.propertiesToSync); return }
        m.leaveSpaceRequestMessage?.let { leaveSpace(it.spaceName); return }
        m.answerMessage?.let { pendingQueries.remove(it.id)?.complete(it); return }
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
                send(ClientToServerMessage(userMovesMessage = UserMovesMessage(position = positionMessage(lastMoving), viewport = viewport())))
            }
        }
    }
}
