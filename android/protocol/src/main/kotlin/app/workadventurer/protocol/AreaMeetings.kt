package app.workadventurer.protocol

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.Normalizer
import kotlin.coroutines.coroutineContext
import kotlin.math.abs

/** A map area's `livekitRoomProperty`: standing in the area puts you in a meeting that has its own space. */
data class MeetingRoom(val propertyId: String?, val roomName: String?)

/**
 * The space a meeting-room area uses, computed the way the web client does (and the Node adapter in
 * src/adapters/wa-helpers.mjs does): `slugify(shortHash(roomUrl) + "-" + (roomName if not blank, else the property id))`. The
 * server only recognises the space if this is byte-for-byte the same string.
 */
fun areaMeetingSpaceName(roomUrl: String, room: MeetingRoom): String {
    val label = room.roomName?.takeIf { it.isNotBlank() } ?: room.propertyId.orEmpty()
    return slugify(shortHash(roomUrl) + "-" + label)
}

// JS: h = ((h << 5) - h + charCode) | 0 per UTF-16 unit, then Math.abs(h).toString(36). Int arithmetic wraps the same way.
internal fun shortHash(s: String): String {
    var h = 0
    for (c in s) h = (h shl 5) - h + c.code
    return abs(h.toLong()).toString(36)
}

// JS: NFD, drop combining marks, lowercase, trim, drop everything but [a-z0-9-_ ], whitespace runs to "-".
internal fun slugify(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFD)
        .replace(Regex("[\\u0300-\\u036f]"), "")
        .lowercase()
        .trim()
        .replace(Regex("[^a-z0-9-_ ]"), "")
        .replace(Regex("\\s+"), "-")

/**
 * Turns "which meeting areas am I standing in" (fed on every pose update) into join and leave calls, with the Node client's
 * debounce: join only after [dwellMs] continuously inside, so walking THROUGH an area doesn't spin a WebRTC peer up and straight
 * back down; leave only [lingerMs] after going out, and walking back in cancels the leave.
 */
class MeetingAreaTracker(
    private val scope: CoroutineScope,
    private val dwellMs: Long,
    private val lingerMs: Long,
    private val onJoin: (String) -> Unit,
    private val onLeave: (String) -> Unit,
) {
    private val lock = Any()
    private val joinTimers = HashMap<String, Job>()
    private val leaveTimers = HashMap<String, Job>()
    private val joined = HashSet<String>()

    /** [current] is the full set of meeting spaces whose areas contain us right now; calling it again with the same set is free. */
    fun update(current: Set<String>) = synchronized(lock) {
        for (name in current) {
            leaveTimers.remove(name)?.cancel() // walked back in: stay
            if (name !in joined && name !in joinTimers) joinTimers[name] = scope.launch {
                delay(dwellMs)
                val me = coroutineContext[Job]
                val go = synchronized(lock) { (joinTimers[name] === me).also { if (it) { joinTimers.remove(name); joined += name } } }
                if (go) onJoin(name)
            }
        }
        for (name in joinTimers.keys.filter { it !in current }) joinTimers.remove(name)?.cancel() // left before we joined
        for (name in joined.filter { it !in current && it !in leaveTimers }) leaveTimers[name] = scope.launch {
            delay(lingerMs)
            val me = coroutineContext[Job]
            val go = synchronized(lock) { (leaveTimers[name] === me).also { if (it) { leaveTimers.remove(name); joined -= name } } }
            if (go) onLeave(name)
        }
    }

    fun close() = synchronized(lock) {
        joinTimers.values.forEach { it.cancel() }; leaveTimers.values.forEach { it.cancel() }
        joinTimers.clear(); leaveTimers.clear(); joined.clear()
    }
}
