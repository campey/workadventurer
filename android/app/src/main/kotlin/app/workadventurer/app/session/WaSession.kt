package app.workadventurer.app.session

import app.workadventurer.nav.Navigator
import app.workadventurer.nav.Pt
import app.workadventurer.nav.Target
import app.workadventurer.nav.frontOf
import app.workadventurer.nav.nearestFreeOutside
import app.workadventurer.nav.nearestOutside
import app.workadventurer.nav.snapToFree
import app.workadventurer.nav.snapToReachable
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.Group
import app.workadventurer.protocol.Invite
import app.workadventurer.protocol.InviteOutcome
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.NewVersionRefused
import app.workadventurer.protocol.catalog.AdapterAnswer
import app.workadventurer.protocol.catalog.AdapterOffer
import app.workadventurer.protocol.catalog.RecoverOutcome
import app.workadventurer.protocol.Player
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.Texture
import app.workadventurer.protocol.toFacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.math.hypot

/** Everything the UI, notification buttons and (later) media buttons can ask the session to do. */
sealed interface Command {
    data class Join(val config: RoomConfig) : Command
    data object Leave : Command
    data class WalkToPlayer(val userId: Int) : Command
    data class WalkToArea(val areaKey: String) : Command // Area.id ?: Area.name
    data object StopMoving : Command

    /** The answer to the "download an adapter?" question ([Connection.NeedsConsent]). Ignored when none is open. */
    data class AnswerAdapter(val answer: AdapterAnswer) : Command

    /** Leave the bubble or meeting area we are in. The protocol has no such message, so this walks out of it. */
    data object LeaveConversation : Command

    /** "Invite to discussion": ask a player to come over to us. */
    data class InvitePlayer(val userId: Int) : Command

    /** Choose your own status (#111). Sent at once when in a room, and remembered for the next join and every reconnect. */
    data class SetStatus(val status: app.workadventurer.proto.AvailabilityStatus) : Command

    /** Answer yes to an invitation we received, then walk to whoever sent it. */
    data class SetMuted(val muted: Boolean, val source: String = "ui") : Command // source only labels the call log
    data class AcceptInvite(val senderUuid: String) : Command { override fun toString() = "AcceptInvite" } // uuid is an email
    data class DeclineInvite(val senderUuid: String) : Command { override fun toString() = "DeclineInvite" }
}

sealed interface Connection {
    data object Disconnected : Connection
    data object Connecting : Connection
    data object Connected : Connection
    data class Reconnecting(val attempt: Int, val inMs: Long) : Connection
    data class Failed(val message: String) : Connection

    /** The server refused our version and a downloadable adapter exists: waiting for the user's answer ([Command.AnswerAdapter]). */
    data class NeedsConsent(val offer: AdapterOffer) : Connection
}

/** What the avatar is doing about movement right now. */
sealed interface Activity {
    data object Idle : Activity
    data class WalkingTo(val label: String) : Activity
    data class WalkingOut(val label: String) : Activity
}

/** The state of the last invite *we* sent. */
sealed interface InviteStatus {
    data class Sent(val label: String) : InviteStatus
    data class Accepted(val name: String) : InviteStatus
    data class Declined(val name: String) : InviteStatus
    data object TooMany : InviteStatus
}

data class SessionState(
    val connection: Connection = Connection.Disconnected,
    val roomName: String = "",
    val players: List<Player> = emptyList(), // sorted by name, case-insensitive
    val areas: List<Area> = emptyList(),
    val inAreas: List<Area> = emptyList(),
    val activity: Activity = Activity.Idle,
    val pendingInvites: List<Invite> = emptyList(), // invitations we received and haven't answered
    val inviteStatus: InviteStatus? = null,
    /** Where we stand, rounded to the nearest 64 px (so walking doesn't redraw the Users list every step); null until known. */
    val myX: Int? = null,
    val myY: Int? = null,
    /** The name we joined with. */
    val myName: String = "",
    /** Our own user id in the room, once the server has told us. */
    val myUserId: Int? = null,
    /** The layers of our own woka picture. */
    val myTextures: List<Texture> = emptyList(),
    /** Every bubble the server has told us about (it only streams those near us), ordered by group id. */
    val groups: List<Group> = emptyList(),
    /** The bubble we are in, one of [groups], or null. */
    val myGroupId: Int? = null,
    /** The microphone. A join starts with the mic state its [RoomConfig.micOn] asks for (muted unless the app remembered otherwise). */
    val muted: Boolean = true,
    /** The status we announce (#111). Kept across leaving and rejoining; the server treats some of them as "not in any conversation". */
    val myStatus: app.workadventurer.proto.AvailabilityStatus = app.workadventurer.proto.AvailabilityStatus.ONLINE,
    /** The audio of the meeting you are in: only different from None while it is on the server's LiveKit room (#134). */
    val audio: app.workadventurer.voice.AudioStatus = app.workadventurer.voice.AudioStatus.None,
)

typealias ConnectionFactory = (RoomConfig) -> PusherConnection

/** Started once per live connection after it is Connected; the returned handle is closed when that connection ends. */
typealias VoiceHost = (PusherConnection) -> VoiceHandle

/** What the session can ask of a running voice mesh. */
interface VoiceHandle : AutoCloseable {
    fun setMuted(muted: Boolean)

    /** Where the audio of the meeting stands (#134): joining the server's LiveKit room, in it, or it would not connect. */
    val audio: kotlinx.coroutines.flow.StateFlow<app.workadventurer.voice.AudioStatus>
        get() = kotlinx.coroutines.flow.MutableStateFlow(app.workadventurer.voice.AudioStatus.None)
}

// WorkAdventure (v1.34.0 defaults, back/src/Enum/EnvironmentVariableValidator.ts): two players form a bubble at
// <= MINIMUM_DISTANCE = 64 px, and you join an existing bubble at <= GROUP_RADIUS = 48 px. "Walk to a player" must
// therefore end inside 48 px, or you can't talk to them. Stand 40 px in front of them and stop within 8 px of that
// spot: the avatar ends 32-48 px away, always inside the smaller radius.
private const val BUBBLE_SPACING_PX = 40.0
private const val ARRIVE_WITHIN_PX = 8.0

// A walk to a player is done once we're inside bubble range of the PLAYER (not once we've hit the exact spot we aimed
// at, which moves when they do), and it gives up after a while instead of chasing someone who keeps walking away.
// Without both, "Walking to X" never went away on a real phone and looked like the old follow loop.
private const val BUBBLE_ARRIVE_PX = 44.0
private const val BUBBLE_LEAVE_PX = 96.0 // clear of a bubble's ~48 px reach, with room to spare
private const val WALK_TO_PLAYER_TIMEOUT_MS = 30_000L
private const val INVITE_OUTCOME_SHOWN_MS = 10_000L // "Ada accepted your invitation" is news for a few seconds
private const val INVITE_SENT_SHOWN_MS = 60_000L // "Inviting Ada…" waits a while for an answer (#117)

/**
 * Owns one room presence: state out, [Command]s in. No Android imports, so it unit-tests on the JVM.
 *
 * A first-attempt [JoinFailed] (bad room/version) is final; anything else, and any drop after we were
 * connected, reconnects with a fresh connection (fresh login) and capped exponential backoff. The backoff
 * only resets once a connection has stayed up for [stableAfterMs], so a connection that joins and drops
 * straight away can't hammer the server (or flicker an avatar in and out of a shared room) every second.
 *
 * Movement commands ([Command.WalkToPlayer] etc.) are ignored unless [Connection.Connected]; a new movement replaces
 * the current one; Join, Leave, a failed join and a dropped connection all cancel it.
 *
 * Thread-safety: [dispatch] runs on the caller's thread while runs execute on [scope]'s threads. Every
 * Join/Leave bumps a generation under [lock]; a run only writes state or adopts a connection while its
 * generation is still current, so a late write from a cancelled run can never override a newer Leave/Join.
 */
class WaSession(
    private val scope: CoroutineScope,
    private val factory: ConnectionFactory,
    private val backoffMs: (attempt: Int) -> Long = { minOf(30_000L, 1_000L shl (it - 1).coerceAtMost(5)) },
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 }, // monotonic: a clock change must not stretch walk deadlines
    private val stableAfterMs: Long = 30_000,
    private val voiceHost: VoiceHost = { object : VoiceHandle { override fun setMuted(muted: Boolean) {}; override fun close() {} } },
    /** Why connections drop or fail (messages only: no ids, no uuids). Goes to logcat in the app. */
    private val log: (String) -> Unit = {},
    /** Asked once per NEW_VERSION refusal for an adapter; null means no recovery (the refusal is just shown). */
    private val recovery: AdapterRecovery? = null,
) {
    /** What we announce about ourselves; read by every connection the run opens, so a reconnect keeps it. */
    @Volatile private var myStatus = app.workadventurer.proto.AvailabilityStatus.ONLINE
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private val lock = Any()
    private var generation = 0
    private var job: Job? = null
    private var conn: PusherConnection? = null
    private var moveJob: Job? = null
    private var moveSeq = 0
    private var voiceHandle: VoiceHandle? = null
    private var consent: CompletableDeferred<AdapterAnswer>? = null
    private var consentBefore: Connection = Connection.Connecting // the state to go back to once the question is answered

    /** Caller holds [lock]. The mic follows the mute choice on both the connection (announcements) and the voice (capture). */
    private fun applyMute(muted: Boolean) {
        conn?.setMicOn(!muted)
        voiceHandle?.setMuted(muted)
    }

    fun dispatch(cmd: Command) {
        synchronized(lock) {
            when (cmd) {
                is Command.Join -> {
                    val gen = restart()
                    // Set synchronously so observers never see the previous room's (or a stale Failed) state first.
                    _state.value = SessionState(connection = Connection.Connecting, roomName = cmd.config.roomUrl, myName = cmd.config.name, muted = !cmd.config.micOn, myStatus = myStatus)
                    job = scope.launch { run(cmd.config, gen) }
                }
                Command.Leave -> {
                    restart()
                    _state.value = SessionState(myStatus = myStatus)
                }
                is Command.WalkToPlayer -> startMovement { c ->
                    val p = c.state.players.value[cmd.userId] ?: return@startMovement null
                    Plan(Activity.WalkingTo(label(p))) { nav ->
                        nav.navTo(
                            target = Pt(p.x.toDouble(), p.y.toDouble()),
                            stopWithin = ARRIVE_WITHIN_PX,
                            getTarget = { targetOf(c, cmd.userId)?.let { frontOf(it, c.position(), BUBBLE_SPACING_PX, c.grid.value) } },
                            face = { targetOf(c, cmd.userId)?.let { Pt(it.x, it.y) } },
                            // Re-plan twice a second so a player who walks away (or leaves) is noticed quickly,
                            // instead of chasing where they were up to 2 s ago.
                            repathMs = 500,
                            arrivedWhen = { me -> targetOf(c, cmd.userId)?.let { hypot(it.x - me.x, it.y - me.y) <= BUBBLE_ARRIVE_PX } == true },
                            timeoutMs = WALK_TO_PLAYER_TIMEOUT_MS,
                        )
                    }
                }
                is Command.WalkToArea -> startMovement { c ->
                    val a = c.state.areas.firstOrNull { (it.id ?: it.name) == cmd.areaKey } ?: return@startMovement null
                    Plan(Activity.WalkingTo(a.name)) { nav ->
                        val centre = Pt(a.x + a.w / 2.0, a.y + a.h / 2.0)
                        // a spot we can walk to: the area's centre may be solid, or in a walled-off pocket
                        nav.navTo(c.grid.value?.snapToReachable(c.position(), centre.x, centre.y) ?: centre, stopWithin = 24.0)
                    }
                }
                Command.LeaveConversation -> startMovement { c ->
                    val st = _state.value
                    val group = st.myGroupId?.let { id -> st.groups.firstOrNull { it.groupId == id } }
                    val areas = st.inAreas
                    val inside: (Pt) -> Boolean
                    val label: String
                    if (group != null) {
                        inside = { hypot(it.x - group.x, it.y - group.y) <= BUBBLE_LEAVE_PX }
                        label = "the bubble"
                    } else if (areas.isNotEmpty()) {
                        inside = { p -> areas.any { p.x >= it.x && p.x < it.x + it.w && p.y >= it.y && p.y < it.y + it.h } }
                        label = areas.first().name
                    } else return@startMovement null
                    val me = c.position()
                    val out = (c.grid.value?.nearestFreeOutside(me, inside) ?: nearestOutside(me, inside)) ?: return@startMovement null
                    Plan(Activity.WalkingOut(label)) { nav -> nav.navTo(out, stopWithin = ARRIVE_WITHIN_PX) }
                }
                is Command.SetMuted -> {
                    // Remembered either way; only applied to a live connection. A Join starts from its own config, see SessionState.
                    _state.update { it.copy(muted = cmd.muted) }
                    val live = _state.value.connection == Connection.Connected
                    log("mic ${if (cmd.muted) "muted" else "unmuted"} (${cmd.source})${if (live) "" else ", not in a call so only remembered"}")
                    if (live) applyMute(cmd.muted)
                }
                Command.StopMoving -> stopMovement()
                is Command.AnswerAdapter -> consent?.let { d ->
                    // The first answer wins; the dialog goes away now, back to the state we were in (never a fresh Connecting).
                    if (d.complete(cmd.answer) && _state.value.connection is Connection.NeedsConsent) _state.update { it.copy(connection = consentBefore) }
                }
                is Command.SetStatus -> {
                    myStatus = cmd.status
                    _state.update { it.copy(myStatus = cmd.status) }
                    log("status ${cmd.status.name}${if (_state.value.connection == Connection.Connected) "" else ", not in a room so only remembered"}")
                    if (_state.value.connection == Connection.Connected) conn?.setAvailabilityStatus(cmd.status)
                }
                is Command.InvitePlayer -> {
                    val c = conn
                    val p = c?.state?.players?.value?.get(cmd.userId)
                    if (c != null && p != null && _state.value.connection == Connection.Connected) {
                        c.state.setInviteOutcome(null) // an older outcome must not overwrite "sent"
                        c.sendInvite(p.uuid, p.userId)
                        _state.update { it.copy(inviteStatus = InviteStatus.Sent(label(p))) }
                    }
                }
                is Command.DeclineInvite -> answerInvite(cmd.senderUuid, accept = false)
                is Command.AcceptInvite -> {
                    val invite = answerInvite(cmd.senderUuid, accept = true)
                    if (invite != null) startMovement { c ->
                        Plan(Activity.WalkingTo(invite.senderName)) { nav -> walkToInviter(c, nav, invite) }
                    }
                }
            }
        }
    }

    /** Ends the current presence run (and any movement) and returns the new generation. Caller holds [lock]. */
    private fun restart(): Int {
        generation++
        job?.cancel(); job = null
        consent?.cancel(); consent = null
        conn?.close(); conn = null
        stopMovement()
        return generation
    }

    /** Caller holds [lock]. Answers the pending invite from [senderUuid]; null (and nothing sent) if there isn't one. */
    private fun answerInvite(senderUuid: String, accept: Boolean): Invite? {
        val c = conn ?: return null
        if (_state.value.connection != Connection.Connected) return null
        val invite = c.state.pendingInvites.value.firstOrNull { it.senderUuid == senderUuid } ?: return null
        c.respondToInvite(senderUuid, accept)
        return invite
    }

    /** Walk to whoever invited us. The server only streams nearby players, so a sender out of view is located first. */
    private suspend fun walkToInviter(c: PusherConnection, nav: Navigator, invite: Invite) {
        fun visible() = c.state.players.value.values.firstOrNull { it.uuid == invite.senderUuid }
        val located: Pt = visible()?.let { Pt(it.x.toDouble(), it.y.toDouble()) }
            ?: c.locate(invite.senderUuid, invite.playUri)
            ?: return // can't find them: the invite is answered, there's just nowhere to walk
        nav.navTo(
            target = located,
            stopWithin = ARRIVE_WITHIN_PX,
            // once they come into view, track their live position and stop in front of them
            getTarget = {
                visible()?.let { v ->
                    frontOf(Target(v.x.toDouble(), v.y.toDouble(), v.direction.toFacing()), c.position(), BUBBLE_SPACING_PX, c.grid.value)
                } ?: located
            },
            face = { visible()?.let { Pt(it.x.toDouble(), it.y.toDouble()) } },
            repathMs = 500,
            arrivedWhen = { me -> visible()?.let { hypot(it.x.toDouble() - me.x, it.y.toDouble() - me.y) <= BUBBLE_ARRIVE_PX } == true },
            timeoutMs = WALK_TO_PLAYER_TIMEOUT_MS,
        )
    }

    private class Plan(val activity: Activity, val run: suspend (Navigator) -> Unit)

    private fun label(p: Player) = p.name.ifBlank { "Unnamed player" }

    private fun targetOf(c: PusherConnection, userId: Int): Target? =
        c.state.players.value[userId]?.let { Target(it.x.toDouble(), it.y.toDouble(), it.direction.toFacing()) }

    /** Caller holds [lock]. Only while Connected; a new movement replaces the current one. */
    private fun startMovement(build: (PusherConnection) -> Plan?) {
        val c = conn ?: return
        if (_state.value.connection != Connection.Connected) return
        // The socket can have closed before the run has noticed and moved us to Reconnecting.
        if (c.closed.isCompleted) return
        val plan = build(c) ?: return
        val replaced = moveJob
        replaced?.cancel()
        val id = ++moveSeq
        val gen = generation
        _state.update { it.copy(activity = plan.activity) }
        moveJob = scope.launch {
            // Let the replaced movement finish its final stop first, so its stale pose can't land after our first step.
            replaced?.join()
            try {
                plan.run(Navigator({ c.grid.value }, c, nowMs))
            } finally {
                synchronized(lock) {
                    if (gen == generation && id == moveSeq) {
                        moveJob = null
                        _state.update { it.copy(activity = Activity.Idle) }
                    }
                }
            }
        }
    }

    /** Caller holds [lock]. */
    private fun stopMovement() {
        moveSeq++
        moveJob?.cancel(); moveJob = null
        _state.update { it.copy(activity = Activity.Idle) }
    }

    private fun setState(gen: Int, f: (SessionState) -> SessionState) = synchronized(lock) {
        if (gen == generation) _state.update(f)
    }

    /** Adopt [c] as the live connection, unless a newer dispatch has already superseded this run. */
    private fun adopt(gen: Int, c: PusherConnection): Boolean = synchronized(lock) {
        if (gen != generation) false else { conn = c; true }
    }

    private fun isCurrent(gen: Int) = synchronized(lock) { gen == generation }

    /** The consent question as state: [Connection.NeedsConsent] until [Command.AnswerAdapter] (or a Leave/Join) ends it. */
    private suspend fun askConsent(gen: Int, offer: AdapterOffer): AdapterAnswer {
        val d = CompletableDeferred<AdapterAnswer>()
        val open = synchronized(lock) {
            if (gen != generation) false else { consent = d; consentBefore = _state.value.connection; _state.update { it.copy(connection = Connection.NeedsConsent(offer)) }; true }
        }
        if (!open) return AdapterAnswer.NO
        try {
            return d.await()
        } finally {
            synchronized(lock) {
                if (consent === d) consent = null
                if (gen == generation && _state.value.connection is Connection.NeedsConsent) _state.update { it.copy(connection = consentBefore) }
            }
        }
    }

    private sealed interface Recovered {
        data class Retry(val cfg: RoomConfig) : Recovered
        data class Fail(val message: String) : Recovered
        data object Superseded : Recovered
    }

    /** One recovery for one refusal: ask the port, turn its outcome into a config to retry with or a message to show. */
    private suspend fun recoverFor(cfg: RoomConfig, original: String, gen: Int): Recovered {
        val port = recovery ?: return Recovered.Fail(original)
        val outcome = try {
            port.recover(cfg.roomUrl) { offer -> askConsent(gen, offer) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("adapter recovery failed: ${e.javaClass.simpleName}")
            RecoverOutcome.Unavailable("recovery failed")
        }
        if (!isCurrent(gen)) return Recovered.Superseded // a Leave/Join happened meanwhile: never connect with this config
        // The Unavailable reason is already sanitised and capped by the library; it says why a check failed (timeout, redirect, no meta tag, bad sha256...).
        log("adapter recovery: ${outcome.javaClass.simpleName}" + ((outcome as? RecoverOutcome.Unavailable)?.let { ": ${it.reason}" } ?: ""))
        val next = when (outcome) {
            is RecoverOutcome.Applied -> cfg.copy(apiVersionHash = outcome.hash, handshakeQuery = outcome.handshakeQuery)
            is RecoverOutcome.Known -> cfg.copy(apiVersionHash = outcome.hash, handshakeQuery = outcome.handshakeQuery)
            else -> null
        }
        // A Known that changes nothing (a built-in hash the server refused anyway) would only repeat the refusal.
        if (next != null && next != cfg) return Recovered.Retry(next)
        return Recovered.Fail(recoveryFailureMessage(outcome, original))
    }

    private suspend fun run(initial: RoomConfig, gen: Int) {
        var cfg = initial
        var attempt = 0
        var everConnected = false
        // Recovery runs at most once per stretch without a successful connect: a refusal that persists with the adapted
        // config is shown (the original message), never retried through recovery again.
        var recoveryTried = false
        var firstRefusal: String? = null
        while (true) {
            val c = factory(cfg.copy(availabilityStatus = myStatus))
            if (!adopt(gen, c)) { c.close(); return }
            var upAt = -1L
            var voice: VoiceHandle? = null
            var refusal: NewVersionRefused? = null
            try {
                c.connect()
                everConnected = true
                recoveryTried = false; firstRefusal = null
                upAt = nowMs()
                setState(gen) { it.copy(connection = Connection.Connected, areas = c.state.areas) }
                voice = try { voiceHost(c) } catch (e: Exception) { null } // voice must never take presence down with it
                val handle = voice
                synchronized(lock) { if (gen == generation) { voiceHandle = handle; applyMute(_state.value.muted) } }
                coroutineScope {
                    // A child of this run, so it can't outlive it or leak past a Leave.
                    val mirror = launch { mirrorState(c, gen) }
                    val audioMirror = handle?.let { h -> launch { h.audio.collect { a -> setState(gen) { it.copy(audio = a) } } } }
                    try {
                        val closed = c.closed.await()
                        log("connection dropped: ${closed.code} ${closed.reason}") // so "Reconnecting" always has a reason on record
                    } finally { mirror.cancel(); audioMirror?.cancel(); setState(gen) { it.copy(audio = app.workadventurer.voice.AudioStatus.None) } }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: NewVersionRefused) {
                if (!recoveryTried) {
                    refusal = e // handled below, once this connection is closed
                } else {
                    // Refused again with the adapted config: show the original refusal, never loop (also after an earlier success).
                    setState(gen) { it.copy(connection = Connection.Failed(firstRefusal ?: e.message ?: "join failed")) }
                    return
                }
            } catch (e: JoinFailed) {
                if (!everConnected) {
                    setState(gen) { it.copy(connection = Connection.Failed(e.message ?: "join failed")) }
                    return
                }
                // After an earlier success a join failure is treated as transient: retry below.
                log("join failed after an earlier success, retrying: ${e.message}")
            } catch (e: Exception) {
                // transient: retry below
                log("connection attempt failed, retrying: ${e.javaClass.simpleName}: ${e.message}")
            } finally {
                synchronized(lock) { if (gen == generation) stopMovement() }
                synchronized(lock) { if (voiceHandle === voice) voiceHandle = null }
                try { voice?.close() } catch (e: Exception) { /* never let voice cleanup break the reconnect loop */ }
                c.close()
                c.state.clear()
            }
            val r = refusal
            if (r != null) {
                recoveryTried = true
                val original = r.message ?: "join failed"
                firstRefusal = original
                when (val rec = recoverFor(cfg, original, gen)) {
                    is Recovered.Retry -> { cfg = rec.cfg; continue }
                    Recovered.Superseded -> return
                    is Recovered.Fail -> {
                        setState(gen) { it.copy(connection = Connection.Failed(rec.message)) }
                        return
                    }
                }
            }
            if (upAt >= 0 && nowMs() - upAt >= stableAfterMs) attempt = 0
            attempt++
            val wait = backoffMs(attempt)
            setState(gen) {
                it.copy(
                    connection = Connection.Reconnecting(attempt, wait),
                    players = emptyList(), inAreas = emptyList(), pendingInvites = emptyList(), inviteStatus = null,
                    groups = emptyList(), myGroupId = null, myUserId = null, myX = null, myY = null,
                )
            }
            delay(wait)
        }
    }

    private suspend fun mirrorState(c: PusherConnection, gen: Int) = coroutineScope {
        launch {
            combine(c.state.groups, c.state.groupId, c.state.myUserId, c.state.myTextures) { groups, mine, id, textures ->
                listOf(groups, mine, id, textures)
            }.collect { _ ->
                setState(gen) {
                    it.copy(
                        groups = c.state.groups.value.values.sortedBy { g -> g.groupId },
                        myGroupId = c.state.groupId.value,
                        myUserId = c.state.myUserId.value,
                        myTextures = c.state.myTextures.value,
                    )
                }
            }
        }
        // A status line is news, not state: it fades, and the room's remembered outcome goes with it or the next
        // players/pose update would bring it straight back (#117).
        launch {
            _state.map { it.inviteStatus }.distinctUntilChanged().collectLatest { status ->
                if (status == null) return@collectLatest
                delay(if (status is InviteStatus.Sent) INVITE_SENT_SHOWN_MS else INVITE_OUTCOME_SHOWN_MS)
                c.state.setInviteOutcome(null)
                setState(gen) { if (it.inviteStatus == status) it.copy(inviteStatus = null) else it }
            }
        }
        // Pose too, so `inAreas` follows the avatar as it walks.
        combine(c.state.players, c.state.myPose, c.state.pendingInvites, c.state.inviteOutcome) { players, _, invites, outcome ->
            Triple(players, invites, outcome)
        }.collect { (players, invites, outcome) ->
            setState(gen) {
                it.copy(
                    players = players.values.sortedBy { p -> p.name.lowercase() },
                    inAreas = c.state.currentAreas(),
                    myX = c.state.myPose.value.let { p -> roundTo64(p.x) },
                    myY = c.state.myPose.value.let { p -> roundTo64(p.y) },
                    pendingInvites = invites,
                    // no outcome yet means keep whatever we show (e.g. "sent")
                    inviteStatus = outcome?.toStatus() ?: it.inviteStatus,
                )
            }
        }
    }

    private fun InviteOutcome.toStatus(): InviteStatus = when (this) {
        is InviteOutcome.Accepted -> InviteStatus.Accepted(name)
        is InviteOutcome.Declined -> InviteStatus.Declined(name)
        InviteOutcome.TooMany -> InviteStatus.TooMany
    }
}

private fun roundTo64(v: Double): Int = Math.round(v / 64.0).toInt() * 64
