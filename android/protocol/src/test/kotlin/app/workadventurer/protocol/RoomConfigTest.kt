package app.workadventurer.protocol

import kotlin.test.Test
import kotlin.test.assertEquals

class RoomConfigTest {
    @Test
    fun aProdRoomUsesTheProdPusherAndWoka() {
        val c = RoomConfig.forRoom("Ada", "https://play.workadventu.re/@/afrolabs/afrolabs/open-space")
        assertEquals(Wa133.DEFAULT_PUSHER, c.pusherUrl); assertEquals(Wa133.DEFAULT_WOKA, c.wokaId)
        assertEquals("Ada", c.name); assertEquals("https://play.workadventu.re/@/afrolabs/afrolabs/open-space", c.roomUrl)
    }

    // Live: staging has its own pusher and woka catalogue; a prod woka id is refused ("invalid character texture").
    @Test
    fun aStagingRoomUsesTheStagingPusherAndAStagingWoka() {
        val c = RoomConfig.forRoom("Ada", "https://play.staging.workadventu.re/@/tcm/workadventure/wa-village")
        assertEquals("https://pusher.staging.workadventu.re", c.pusherUrl)
        assertEquals(WaStaging.DEFAULT_WOKA, c.wokaId)
    }

    @Test
    fun anUnknownOrMalformedHostFallsBackToProd() {
        assertEquals(Wa133.DEFAULT_PUSHER, RoomConfig.forRoom("Ada", "not a url").pusherUrl)
        assertEquals(Wa133.DEFAULT_PUSHER, RoomConfig.forRoom("Ada", "https://example.org/@/a/b/c").pusherUrl)
    }
}
