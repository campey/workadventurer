package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.math.roundToInt

/** One layer of a woka (avatar) picture: a public PNG sprite sheet, layered in the order the server sends them. */
data class Texture(val id: String, val url: String)

data class Player(
    val userId: Int,
    val name: String,
    val uuid: String,
    val x: Int,
    val y: Int,
    val direction: PositionMessage.Direction,
    val availabilityStatus: AvailabilityStatus = AvailabilityStatus.ONLINE,
    val textures: List<Texture> = emptyList(),
) {
    // uuid is the account email for logged-in players: keep it out of anything that stringifies a player.
    override fun toString() = "Player(userId=$userId, name=$name, x=$x, y=$y, direction=$direction)"
}

/** A proximity bubble the server told us about: where it is (map pixels) and who is in it. */
data class Group(val groupId: Int, val x: Int, val y: Int, val userIds: List<Int>)

/** Our own avatar: position in (fractional) map pixels, rounded only when it goes on the wire. */
data class Pose(val x: Double, val y: Double, val facing: Facing)

/** Reduces server sub-messages into observable room state. Mirrors WorkAdventureClient._handleSub. */
class RoomState {
    private val _players = MutableStateFlow<Map<Int, Player>>(emptyMap())
    private val _myUserId = MutableStateFlow<Int?>(null)
    private val _groupId = MutableStateFlow<Int?>(null)
    private val _groups = MutableStateFlow<Map<Int, Group>>(emptyMap())
    private val _myTextures = MutableStateFlow<List<Texture>>(emptyList())
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

    /** Every bubble the server has told us about (it only streams those near us), by group id. */
    val groups: StateFlow<Map<Int, Group>> = _groups.asStateFlow()

    /** The layers of our own woka picture, from the server's room-joined message. */
    val myTextures: StateFlow<List<Texture>> = _myTextures.asStateFlow()
    fun setMyTextures(textures: List<Texture>) { _myTextures.value = textures }
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
                    availabilityStatus = u.availabilityStatus.takeUnless { s -> s == AvailabilityStatus.UNCHANGED } ?: AvailabilityStatus.ONLINE,
                    textures = u.characterTextures.map { t -> Texture(t.id, t.url) },
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
            _groups.update { it + (g.groupId to Group(g.groupId, g.position?.x ?: 0, g.position?.y ?: 0, g.userIds)) }
            followMyGroup(g.groupId, g.userIds)
        }
        sub.groupUsersUpdateMessage?.let { g ->
            // Members only: the position stays. An unknown group can't be placed, so it waits for its full update.
            _groups.update { cur -> cur[g.groupId]?.let { cur + (g.groupId to it.copy(userIds = g.userIds)) } ?: cur }
            if (_groups.value.containsKey(g.groupId)) followMyGroup(g.groupId, g.userIds)
        }
        sub.groupDeleteMessage?.let { g ->
            _groups.update { it - g.groupId }
            if (_groupId.value == g.groupId) _groupId.value = null
        }
        sub.playerDetailsUpdatedMessage?.let { m ->
            val status = m.details?.availabilityStatus ?: return@let
            if (status == AvailabilityStatus.UNCHANGED) return@let // this update was about something else
            _players.update { cur -> cur[m.userId]?.let { cur + (m.userId to it.copy(availabilityStatus = status)) } ?: cur }
        }
        sub.initSpaceUsersMessage?.let { m ->
            _spaceUserNames.update { cur -> cur + m.users.filter { it.name.isNotBlank() }.associate { it.spaceUserId to it.name } }
        }
        (sub.addSpaceUserMessage?.user ?: sub.updateSpaceUserMessage?.user)?.let { u ->
            if (u.name.isNotBlank()) _spaceUserNames.update { it + (u.spaceUserId to u.name) }
        }
        sub.removeSpaceUserMessage?.let { r -> _spaceUserNames.update { it - r.spaceUserId } }
    }

    /** Our own bubble is the group that lists us; when the group still exists but no longer lists us, we left it. */
    private fun followMyGroup(groupId: Int, userIds: List<Int>) {
        val mine = _myUserId.value?.let { it in userIds } ?: false
        if (mine) _groupId.value = groupId
        else if (_groupId.value == groupId) _groupId.value = null
    }

    /** Reset live room state (players/group/identity) for a reconnect. Areas are per-room and kept. */
    fun clear() {
        _players.value = emptyMap()
        _myUserId.value = null
        _groupId.value = null
        _groups.value = emptyMap()
        _myTextures.value = emptyList()
        _invites.value = emptyList()
        _inviteOutcome.value = null
        _spaces.value = emptyMap()
        _spaceUserNames.value = emptyMap()
    }
}
