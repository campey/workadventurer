package app.workadventurer.protocol

import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class Player(
    val userId: Int,
    val name: String,
    val uuid: String,
    val x: Int,
    val y: Int,
    val direction: PositionMessage.Direction,
)

/** Reduces server sub-messages into observable room state. Mirrors WorkAdventureClient._handleSub. */
class RoomState {
    private val _players = MutableStateFlow<Map<Int, Player>>(emptyMap())
    private val _myUserId = MutableStateFlow<Int?>(null)
    private val _groupId = MutableStateFlow<Int?>(null)
    @Volatile private var pos = 0 to 0

    val players: StateFlow<Map<Int, Player>> = _players.asStateFlow()
    val myUserId: StateFlow<Int?> = _myUserId.asStateFlow()
    val groupId: StateFlow<Int?> = _groupId.asStateFlow()
    @Volatile var areas: List<Area> = emptyList()

    fun setMyUserId(id: Int) { _myUserId.value = id }
    fun setMyPosition(x: Int, y: Int) { pos = x to y }
    fun myPosition(): Pair<Int, Int> = pos
    fun currentAreas(): List<Area> = areas.filter { it.contains(pos.first, pos.second) }

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
