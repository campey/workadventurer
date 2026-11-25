package app.workadventurer.protocol

import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals

class LiveKitTokenTest {
    private fun jwt(payload: String) =
        "h." + Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toByteArray()) + ".sig"

    // The invitation token is a JWT whose `video.room` claim names the room, which tells a bubble's room from an area's.
    @Test
    fun theRoomIsTheVideoRoomClaim() {
        assertEquals("space-1234", liveKitRoomName(jwt("""{"video":{"room":"space-1234","roomJoin":true}}""")))
    }

    @Test
    fun anythingUnreadableIsAQuestionMark() {
        assertEquals("?", liveKitRoomName("not a token"))
        assertEquals("?", liveKitRoomName(jwt("""{"video":{}}""")))
        assertEquals("?", liveKitRoomName(jwt("not json")))
        assertEquals("?", liveKitRoomName(""))
    }
}
