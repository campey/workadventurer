package app.workadventurer.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import app.workadventurer.app.session.SessionState
import app.workadventurer.protocol.Player
import kotlinx.coroutines.delay

/** How long someone who left stays in the list, dimmed, before the row goes. */
const val LEAVER_HOLD_MS = 4_000L

/** What the row of someone who dropped out of the room says in place of their status: the server only says they are gone, so this is its likeliest cause. */
const val DISCONNECTED_TEXT = "Disconnected…"

/** How faded their row is. */
const val LEFT_ROOM_ALPHA = 0.5f

/** Someone who has just left: who they were, the bubble they were in (if any), and when their row goes. */
data class Leaver(val player: Player, val groupId: Int?, val until: Long)

/**
 * The leavers to show now: [held] ones whose moment isn't up and who haven't come back, plus anyone in [before] who isn't in
 * [now]. You are never a leaver.
 */
fun trackLeavers(before: SessionState?, now: SessionState, held: Map<Int, Leaver>, nowMs: Long): Map<Int, Leaver> {
    val present = now.players.map { it.userId }.toSet()
    val kept = held.filter { (id, l) -> id !in present && l.until > nowMs }
    val added = before?.players.orEmpty()
        .filter { it.userId !in present && it.userId != now.myUserId && it.userId !in kept }
        .associate { p -> p.userId to Leaver(p, before!!.groups.firstOrNull { p.userId in it.userIds }?.groupId, nowMs + LEAVER_HOLD_MS) }
    return kept + added
}

/** [now] with the [held] leavers put back where they were: among the players, and in their bubble if it still exists. */
fun withLeavers(now: SessionState, held: Map<Int, Leaver>): SessionState {
    if (held.isEmpty()) return now
    val players = (now.players + held.values.map { it.player }).sortedBy { it.name.lowercase() }
    val groups = now.groups.map { g ->
        val back = held.values.filter { it.groupId == g.groupId }.map { it.player.userId }
        if (back.isEmpty()) g else g.copy(userIds = g.userIds + back)
    }
    return now.copy(players = players, groups = groups)
}

/**
 * The state to list from: [state] with anyone who just left still in their place, and who they are. Each leaver goes after
 * [LEAVER_HOLD_MS], whether or not anything else changes.
 */
@Composable
fun rememberWithLeavers(state: SessionState): Pair<SessionState, Set<Int>> {
    var before by remember { mutableStateOf<SessionState?>(null) }
    var held by remember { mutableStateOf<Map<Int, Leaver>>(emptyMap()) }
    LaunchedEffect(state) {
        held = trackLeavers(before, state, held, System.currentTimeMillis())
        before = state
        val next = held.values.minOfOrNull { it.until } ?: return@LaunchedEffect
        delay((next - System.currentTimeMillis()).coerceAtLeast(0))
        held = trackLeavers(before, state, held, System.currentTimeMillis())
    }
    return withLeavers(state, held) to held.keys
}

/** Someone who walked out of the bubble or area being looked at (and is still in the room): their row, until [until]. */
data class Walker(val participant: Participant, val until: Long)

/**
 * The room view's walkers to show now: [held] ones whose moment isn't up and who haven't come back, plus anyone in [before] who
 * isn't in [now]. You are never a walker, and neither is someone already leaving the room (their row is already dimmed).
 * [noun] is "bubble" or "area".
 */
fun trackWalkers(before: List<Participant>?, now: List<Participant>, held: Map<Int, Walker>, nowMs: Long, noun: String): Map<Int, Walker> {
    val present = now.mapNotNull { it.userId }.toSet()
    val kept = held.filter { (id, w) -> id !in present && w.until > nowMs }
    val added = before.orEmpty()
        .filter { !it.isMe && it.leaving == null && it.userId != null && it.userId !in present && it.userId !in kept }
        .associate { p -> p.userId!! to Walker(p.copy(leaving = "Left the $noun…"), nowMs + LEAVER_HOLD_MS) }
    return kept + added
}

/** [members] with the [held] walkers put back, dimmed: you first, then by name. */
fun withWalkers(members: List<Participant>, held: Map<Int, Walker>): List<Participant> =
    if (held.isEmpty()) members
    else (members + held.values.map { it.participant }).sortedWith(compareBy<Participant> { !it.isMe }.thenBy { it.name.lowercase() }.thenBy { it.userId })

/** The room view's [members], with anyone who just walked out still there for a moment, dimmed, saying what they did. */
@Composable
fun rememberWithWalkers(members: List<Participant>, noun: String, key: Any): List<Participant> {
    var before by remember(key) { mutableStateOf<List<Participant>?>(null) }
    var held by remember(key) { mutableStateOf<Map<Int, Walker>>(emptyMap()) }
    LaunchedEffect(members, key) {
        held = trackWalkers(before, members, held, System.currentTimeMillis(), noun)
        before = members
        val next = held.values.minOfOrNull { it.until } ?: return@LaunchedEffect
        delay((next - System.currentTimeMillis()).coerceAtLeast(0))
        held = trackWalkers(before, members, held, System.currentTimeMillis(), noun)
    }
    return withWalkers(members, held)
}
