package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.math.roundToInt

data class Player(
    val userId: Int,
    val name: String,
    val uuid: String,
    val x: Int,
    val y: Int,
    val direction: PositionMessage.Direction,
)

/** Our own avatar: position in (fractional) map pixels, rounded only when it goes on the wire. */
data class Pose(val x: Double, val y: Double, val facing: Facing)

/** Reduces server sub-messages into observable room state. Mirrors WorkAdventureClient._handleSub. */
class RoomState {
    private val _players = MutableStateFlow<Map<Int, Player>>(emptyMap())
    private val _myUserId = MutableStateFlow<Int?>(null)
    private val _groupId = MutableStateFlow<Int?>(null)
    private val _pose = MutableStateFlow(Pose(0.0, 0.0, Facing.DOWN))

    val players: StateFlow<Map<Int, Player>> = _players.asStateFlow()
    val myUserId: StateFlow<Int?> = _myUserId.asStateFlow()
    val groupId: StateFlow<Int?> = _groupId.asStateFlow()
    val myPose: StateFlow<Pose> = _pose.asStateFlow()
    @Volatile var areas: List<Area> = emptyList()

    fun setMyUserId(id: Int) { _myUserId.value = id }
    fun setMyPose(x: Double, y: Double, facing: Facing) { _pose.value = Pose(x, y, facing) }
    fun setMyPosition(x: Int, y: Int) { _pose.update { it.copy(x = x.toDouble(), y = y.toDouble()) } }

    /** The pose rounded to whole pixels, as it goes on the wire. */
    fun myPosition(): Pair<Int, Int> = _pose.value.let { it.x.roundToInt() to it.y.roundToInt() }
    fun currentAreas(): List<Area> = myPosition().let { (px, py) -> areas.filter { it.contains(px, py) } }

    fun applySub(sub: SubMessage) {
        sub.userJoinedMessage?.let { u ->
            _players.update {
                it + (u.userId to Player(
                    userId = u.userId,
                    name = u.name,
                    uuid = u.userUuid,
                    x = u.position?.x ?: 0,
                    y = u.position?.y ?: 0,
                    direction = u.position?.direction ?: PositionMessage.Direction.DOWN,
                ))
            }
        }
        sub.userMovedMessage?.let { m ->
            val p = m.position ?: return@let
            _players.update { cur ->
                val existing = cur[m.userId] ?: return@update cur // unknown user: ignore
                cur + (m.userId to existing.copy(x = p.x, y = p.y, direction = p.direction))
            }
        }
        sub.userLeftMessage?.let { l -> _players.update { it - l.userId } }
        sub.groupUpdateMessage?.let { g ->
            val mine = _myUserId.value?.let { it in g.userIds } ?: false
            if (mine) _groupId.value = g.groupId
            else if (_groupId.value == g.groupId) _groupId.value = null
        }
        sub.groupDeleteMessage?.let { g -> if (_groupId.value == g.groupId) _groupId.value = null }
    }

    /** Reset live room state (players/group/identity) for a reconnect. Areas are per-room and kept. */
    fun clear() {
        _players.value = emptyMap()
        _myUserId.value = null
        _groupId.value = null
    }
}
