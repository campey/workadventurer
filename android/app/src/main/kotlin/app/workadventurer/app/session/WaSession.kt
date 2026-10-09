package app.workadventurer.app.session

import app.workadventurer.nav.Navigator
import app.workadventurer.nav.Pt
import app.workadventurer.nav.Target
import app.workadventurer.nav.frontOf
import app.workadventurer.nav.snapToFree
import app.workadventurer.protocol.Area
import app.workadventurer.protocol.Group
import app.workadventurer.protocol.Invite
import app.workadventurer.protocol.InviteOutcome
import app.workadventurer.protocol.JoinFailed
import app.workadventurer.protocol.Player
import app.workadventurer.protocol.PusherConnection
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.Texture
import app.workadventurer.protocol.toFacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
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

    /** "Invite to discussion": ask a player to come over to us. */
    data class InvitePlayer(val userId: Int) : Command

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
}

/** What the avatar is doing about movement right now. */
sealed interface Activity {
    data object Idle : Activity
    data class WalkingTo(val label: String) : Activity
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
)

typealias ConnectionFactory = (RoomConfig) -> PusherConnection

/** Started once per live connection after it is Connected; the returned handle is closed when that connection ends. */
typealias VoiceHost = (PusherConnection) -> VoiceHandle

/** What the session can ask of a running voice mesh. */
interface VoiceHandle : AutoCloseable {
    fun setMuted(muted: Boolean)
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
private const val WALK_TO_PLAYER_TIMEOUT_MS = 30_000L

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
) {
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private val lock = Any()
    private var generation = 0
    private var job: Job? = null
    private var conn: PusherConnection? = null
    private var moveJob: Job? = null
    private var moveSeq = 0
    private var voiceHandle: VoiceHandle? = null

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
                    _state.value = SessionState(connection = Connection.Connecting, roomName = cmd.config.roomUrl, myName = cmd.config.name, muted = !cmd.config.micOn)
                    job = scope.launch { run(cmd.config, gen) }
                }
                Command.Leave -> {
                    restart()
                    _state.value = SessionState()
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
                        nav.navTo(c.grid.value?.snapToFree(centre.x, centre.y) ?: centre, stopWithin = 24.0)
                    }
                }
                is Command.SetMuted -> {
                    // Remembered either way; only applied to a live connection. A Join starts from its own config, see SessionState.
                    _state.update { it.copy(muted = cmd.muted) }
                    val live = _state.value.connection == Connection.Connected
                    log("mic ${if (cmd.muted) "muted" else "unmuted"} (${cmd.source})${if (live) "" else ", not in a call so only remembered"}")
                    if (live) applyMute(cmd.muted)
                }
                Command.StopMoving -> stopMovement()
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

    private suspend fun run(cfg: RoomConfig, gen: Int) {
        var attempt = 0
        var everConnected = false
        while (true) {
            val c = factory(cfg)
            if (!adopt(gen, c)) { c.close(); return }
            var upAt = -1L
            var voice: VoiceHandle? = null
            try {
                c.connect()
                everConnected = true
                upAt = nowMs()
                setState(gen) { it.copy(connection = Connection.Connected, areas = c.state.areas) }
                voice = try { voiceHost(c) } catch (e: Exception) { null } // voice must never take presence down with it
                val handle = voice
                synchronized(lock) { if (gen == generation) { voiceHandle = handle; applyMute(_state.value.muted) } }
                coroutineScope {
                    // A child of this run, so it can't outlive it or leak past a Leave.
                    val mirror = launch { mirrorState(c, gen) }
                    try {
                        val closed = c.closed.await()
                        log("connection dropped: ${closed.code} ${closed.reason}") // so "Reconnecting" always has a reason on record
                    } finally { mirror.cancel() }
                }
            } catch (e: CancellationException) {
                throw e
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
            if (upAt >= 0 && nowMs() - upAt >= stableAfterMs) attempt = 0
            attempt++
            val wait = backoffMs(attempt)
            setState(gen) {
                it.copy(
                    connection = Connection.Reconnecting(attempt, wait),
                    players = emptyList(), inAreas = emptyList(), pendingInvites = emptyList(), inviteStatus = null,
                    groups = emptyList(), myGroupId = null, myUserId = null,
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
        // Pose too, so `inAreas` follows the avatar as it walks.
        combine(c.state.players, c.state.myPose, c.state.pendingInvites, c.state.inviteOutcome) { players, _, invites, outcome ->
            Triple(players, invites, outcome)
        }.collect { (players, invites, outcome) ->
            setState(gen) {
                it.copy(
                    players = players.values.sortedBy { p -> p.name.lowercase() },
                    inAreas = c.state.currentAreas(),
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
