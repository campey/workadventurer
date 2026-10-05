package app.workadventurer.protocol

import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.proto.ClientToServerMessage
import app.workadventurer.proto.JoinRoomFrontMessage
import app.workadventurer.proto.PositionMessage
import app.workadventurer.proto.ViewportMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class WireSmokeTest {
    @Test
    fun joinRoomFrontMessageRoundTrips() {
        val msg = ClientToServerMessage(
            joinRoomFrontMessage = JoinRoomFrontMessage(
                name = "hello",
                positionMessage = PositionMessage(x = 320, y = 640, direction = PositionMessage.Direction.DOWN),
                viewportMessage = ViewportMessage(left = 0, top = 0, right = 3840, bottom = 2160),
                availabilityStatus = AvailabilityStatus.ONLINE,
            ),
        )
        val decoded = ClientToServerMessage.ADAPTER.decode(ClientToServerMessage.ADAPTER.encode(msg))
        assertEquals(msg, decoded)
        assertEquals("hello", decoded.joinRoomFrontMessage!!.name)
    }
}
