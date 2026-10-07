package app.workadventurer.protocol

import app.workadventurer.nav.Facing
import app.workadventurer.proto.GroupDeleteMessage
import app.workadventurer.proto.AddSpaceUserMessage
import app.workadventurer.proto.GroupUpdateMessage
import app.workadventurer.proto.InitSpaceUsersMessage
import app.workadventurer.proto.RemoveSpaceUserPusherToFrontMessage
import app.workadventurer.proto.SpaceUser
import app.workadventurer.proto.UpdateSpaceUserPusherToFrontMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.SubMessage
import app.workadventurer.proto.UserJoinedMessage
import app.workadventurer.proto.UserLeftMessage
import app.workadventurer.proto.UserMovedMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class RoomStateTest {
    private fun join(id: Int, name: String, x: Int = 10, y: Int = 20) = SubMessage(
        userJoinedMessage = UserJoinedMessage(
            userId = id, name = name, userUuid = "uuid-$id",
            position = PositionMessage(x = x, y = y, direction = PositionMessage.Direction.LEFT),
        ),
    )

    @Test
    fun joinMoveLeaveLifecycle() {
        val s = RoomState()
        s.applySub(join(5, "Ada"))
        assertEquals("Ada", s.players.value.getValue(5).name)
        s.applySub(SubMessage(userMovedMessage = UserMovedMessage(userId = 5, position = PositionMessage(x = 99, y = 98, direction = PositionMessage.Direction.UP))))
        assertEquals(99, s.players.value.getValue(5).x)
        assertEquals(PositionMessage.Direction.UP, s.players.value.getValue(5).direction)
        s.applySub(SubMessage(userLeftMessage = UserLeftMessage(userId = 5)))
        assertEquals(emptyMap(), s.players.value)
    }

    @Test
    fun moveForUnknownUserIsIgnored() {
        val s = RoomState()
        s.applySub(SubMessage(userMovedMessage = UserMovedMessage(userId = 404, position = PositionMessage(x = 1, y = 1))))
        assertEquals(emptyMap(), s.players.value)
    }

    @Test
    fun duplicateJoinReplacesInsteadOfDuplicating() {
        val s = RoomState()
        s.applySub(join(1, "Old"))
        s.applySub(join(1, "New"))
        assertEquals(1, s.players.value.size)
        assertEquals("New", s.players.value.getValue(1).name)
    }

    @Test
    fun emptyAndUnicodeNamesAreKept() {
        val s = RoomState()
        s.applySub(join(1, ""))
        s.applySub(join(2, "Zoë 🦊"))
        assertEquals("", s.players.value.getValue(1).name)
        assertEquals("Zoë 🦊", s.players.value.getValue(2).name)
    }

    @Test
    fun onlyTracksTheGroupWeAreIn() {
        val s = RoomState()
        s.setMyUserId(7)
        s.applySub(SubMessage(groupUpdateMessage = GroupUpdateMessage(groupId = 1, userIds = listOf(2, 3))))
        assertNull(s.groupId.value)
        s.applySub(SubMessage(groupUpdateMessage = GroupUpdateMessage(groupId = 2, userIds = listOf(7, 3))))
        assertEquals(2, s.groupId.value)
        s.applySub(SubMessage(groupDeleteMessage = GroupDeleteMessage(groupId = 2)))
        assertNull(s.groupId.value)
    }

    @Test
    fun clearResetsPlayersAndGroupButNotAreas() {
        val s = RoomState()
        s.areas = listOf(Area("a", "A", 0, 0, 10, 10, emptySet(), false, false))
        s.setMyUserId(1)
        s.applySub(join(2, "x"))
        s.clear()
        assertEquals(emptyMap(), s.players.value)
        assertNull(s.myUserId.value)
        assertEquals(1, s.areas.size)
    }

    @Test
    fun currentAreasFollowMyPosition() {
        val s = RoomState()
        s.areas = listOf(Area("a", "A", 0, 0, 100, 100, emptySet(), false, false), Area("b", "B", 500, 500, 10, 10, emptySet(), false, false))
        s.setMyPosition(50, 50)
        assertEquals(listOf("A"), s.currentAreas().map { it.name })
    }

    @Test
    fun poseFlowFollowsMovesRoundsForTheWireAndFeedsCurrentAreas() {
        val s = RoomState()
        s.areas = listOf(
            Area("a", "A", 0, 0, 100, 100, emptySet(), false, false),
            Area("b", "B", 500, 500, 10, 10, emptySet(), false, false),
        )
        s.setMyPose(50.4, 50.6, Facing.LEFT)
        assertEquals(Pose(50.4, 50.6, Facing.LEFT), s.myPose.value)
        assertEquals(50 to 51, s.myPosition())
        assertEquals(listOf("A"), s.currentAreas().map { it.name })
        s.setMyPose(505.0, 505.0, Facing.UP)
        assertEquals(listOf("B"), s.currentAreas().map { it.name })
    }

    @Test
    fun setMyPositionKeepsTheFacing() {
        val s = RoomState()
        s.setMyPose(1.0, 2.0, Facing.LEFT)
        s.setMyPosition(10, 20)
        assertEquals(Pose(10.0, 20.0, Facing.LEFT), s.myPose.value)
    }

    // The uuid is the ACCOUNT EMAIL for logged-in players. A future `Log.i(..., player)` or an exception message that
    // stringifies one of these must not leak it.
    @Test
    fun theUuidNeverAppearsWhenPlayersAndInvitesAreStringified() {
        val email = "someone@example.com"
        val p = Player(1, "Ada", email, 1, 2, PositionMessage.Direction.DOWN)
        val i = Invite(email, "Ada", 1, "https://play/room")
        assertEquals(false, p.toString().contains(email), p.toString())
        assertEquals(false, i.toString().contains(email), i.toString())
        assertEquals(true, p.toString().contains("Ada"))
    }

    @Test
    fun spaceMembershipIsTrackedAndRemoved() {
        val s = RoomState()
        s.addSpace("open-space", "open-space_7")
        assertEquals(mapOf("open-space" to "open-space_7"), s.spaces.value)
        s.removeSpace("open-space")
        assertEquals(emptyMap(), s.spaces.value)
        s.removeSpace("never-joined") // harmless
    }

    @Test
    fun spaceUserNamesFollowInitAddUpdateAndRemove() {
        val s = RoomState()
        s.applySub(SubMessage(initSpaceUsersMessage = InitSpaceUsersMessage(spaceName = "sp", users = listOf(
            SpaceUser(spaceUserId = "sp_1", name = "Ada"), SpaceUser(spaceUserId = "sp_2", name = "Bob")))))
        assertEquals(mapOf("sp_1" to "Ada", "sp_2" to "Bob"), s.spaceUserNames.value)
        s.applySub(SubMessage(addSpaceUserMessage = AddSpaceUserMessage(spaceName = "sp", user = SpaceUser(spaceUserId = "sp_3", name = "Cy"))))
        s.applySub(SubMessage(updateSpaceUserMessage = UpdateSpaceUserPusherToFrontMessage(spaceName = "sp", user = SpaceUser(spaceUserId = "sp_1", name = "Ada L"))))
        s.applySub(SubMessage(updateSpaceUserMessage = UpdateSpaceUserPusherToFrontMessage(spaceName = "sp", user = SpaceUser(spaceUserId = "sp_2", name = "")))) // no name in the update: keep
        s.applySub(SubMessage(removeSpaceUserMessage = RemoveSpaceUserPusherToFrontMessage(spaceName = "sp", spaceUserId = "sp_3")))
        assertEquals(mapOf("sp_1" to "Ada L", "sp_2" to "Bob"), s.spaceUserNames.value)
    }

    @Test
    fun clearForgetsSpaces() {
        val s = RoomState()
        s.addSpace("sp", "sp_1")
        s.applySub(SubMessage(addSpaceUserMessage = AddSpaceUserMessage(spaceName = "sp", user = SpaceUser(spaceUserId = "sp_2", name = "Bob"))))
        s.clear()
        assertEquals(true, s.spaces.value.isEmpty() && s.spaceUserNames.value.isEmpty())
    }
}
