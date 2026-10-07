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
) {
    // uuid is the account email for logged-in players: keep it out of anything that stringifies a player.
    override fun toString() = "Player(userId=$userId, name=$name, x=$x, y=$y, direction=$direction)"
}

/** Our own avatar: position in (fractional) map pixels, rounded only when it goes on the wire. */
data class Pose(val x: Double, val y: Double, val facing: Facing)

/** Reduces server sub-messages into observable room state. Mirrors WorkAdventureClient._handleSub. */
class RoomState {
    private val _players = MutableStateFlow<Map<Int, Player>>(emptyMap())
    private val _myUserId = MutableStateFlow<Int?>(null)
    private val _groupId = MutableStateFlow<Int?>(null)
    private val _pose = MutableStateFlow(Pose(0.0, 0.0, Facing.DOWN))
    private val _invites = MutableStateFlow<List<Invite>>(emptyList())
    private val _inviteOutcome = MutableStateFlow<InviteOutcome?>(null)
    private val _spaces = MutableStateFlow<Map<String, String>>(emptyMap())
    private val _spaceUserNames = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Spaces we are a member of: space name to our space-user id. */
    val spaces: StateFlow<Map<String, String>> = _spaces.asStateFlow()

    /** Display names of space members, by space-user id. Names only: never a uuid. */
    val spaceUserNames: StateFlow<Map<String, String>> = _spaceUserNames.asStateFlow()

    fun addSpace(spaceName: String, spaceUserId: String) { _spaces.update { it + (spaceName to spaceUserId) } }
    fun removeSpace(spaceName: String) { _spaces.update { it - spaceName } }

    val players: StateFlow<Map<Int, Player>> = _players.asStateFlow()
    val myUserId: StateFlow<Int?> = _myUserId.asStateFlow()
    val groupId: StateFlow<Int?> = _groupId.asStateFlow()
    val myPose: StateFlow<Pose> = _pose.asStateFlow()

    /** Invitations other players sent us that we haven't answered. */
    val pendingInvites: StateFlow<List<Invite>> = _invites.asStateFlow()

    /** The latest result of an invite we sent, or null. */
    val inviteOutcome: StateFlow<InviteOutcome?> = _inviteOutcome.asStateFlow()
    @Volatile var areas: List<Area> = emptyList()

    /** A new invite from the same sender replaces their earlier one. */
    fun addInvite(invite: Invite) { _invites.update { list -> list.filterNot { it.senderUuid == invite.senderUuid } + invite } }
    fun removeInvite(senderUuid: String) { _invites.update { list -> list.filterNot { it.senderUuid == senderUuid } } }
    fun clearInvites() { _invites.value = emptyList() }
    fun setInviteOutcome(outcome: InviteOutcome?) { _inviteOutcome.value = outcome }

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
        sub.initSpaceUsersMessage?.let { m ->
            _spaceUserNames.update { cur -> cur + m.users.filter { it.name.isNotBlank() }.associate { it.spaceUserId to it.name } }
        }
        (sub.addSpaceUserMessage?.user ?: sub.updateSpaceUserMessage?.user)?.let { u ->
            if (u.name.isNotBlank()) _spaceUserNames.update { it + (u.spaceUserId to u.name) }
        }
        sub.removeSpaceUserMessage?.let { r -> _spaceUserNames.update { it - r.spaceUserId } }
    }

    /** Reset live room state (players/group/identity) for a reconnect. Areas are per-room and kept. */
    fun clear() {
        _players.value = emptyMap()
        _myUserId.value = null
        _groupId.value = null
        _invites.value = emptyList()
        _inviteOutcome.value = null
        _spaces.value = emptyMap()
        _spaceUserNames.value = emptyMap()
    }
}
