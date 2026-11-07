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

    // Staging runs master, whose hash differs from prod's release hash: each is refused with NEW_VERSION under the other's.
    @Test
    fun aStagingRoomSendsStagingsVersionHashAndAProdRoomSendsProds() {
        assertEquals(WaStaging.API_VERSION_HASH, RoomConfig.forRoom("Ada", "https://play.staging.workadventu.re/@/a/b/c").apiVersionHash)
        assertEquals(Wa133.API_VERSION_HASHES[0], RoomConfig.forRoom("Ada", "https://play.workadventu.re/@/a/b/c").apiVersionHash)
        assertEquals("d2d82672", WaStaging.API_VERSION_HASH)
    }

    // #77: the mic choice made on the Join screen travels with the join.
    @Test
    fun theMicChoiceTravelsWithTheConfigAndDefaultsToMuted() {
        assertEquals(false, RoomConfig.forRoom("Ada", "https://play.workadventu.re/@/a/b/c").micOn)
        assertEquals(true, RoomConfig.forRoom("Ada", "https://play.workadventu.re/@/a/b/c", micOn = true).micOn)
        assertEquals(true, RoomConfig.forRoom("Ada", "https://play.staging.workadventu.re/@/a/b/c", micOn = true).micOn)
    }

    // #108: a woka the player chose replaces the server's default, on prod and on staging alike; none chosen keeps the default.
    @Test
    fun aChosenWokaReplacesTheDefault() {
        assertEquals("mine", RoomConfig.forRoom("Ada", "https://play.workadventu.re/@/a/b/c", wokaId = "mine").wokaId)
        assertEquals("mine", RoomConfig.forRoom("Ada", "https://play.staging.workadventu.re/@/a/b/c", wokaId = "mine").wokaId)
        assertEquals(Wa133.DEFAULT_WOKA, RoomConfig.forRoom("Ada", "https://play.workadventu.re/@/a/b/c", wokaId = null).wokaId)
        assertEquals(Wa133.DEFAULT_WOKA, RoomConfig.forRoom("Ada", "https://play.workadventu.re/@/a/b/c", wokaId = " ").wokaId)
    }

    @Test
    fun anUnknownOrMalformedHostFallsBackToProd() {
        assertEquals(Wa133.DEFAULT_PUSHER, RoomConfig.forRoom("Ada", "not a url").pusherUrl)
        assertEquals(Wa133.DEFAULT_PUSHER, RoomConfig.forRoom("Ada", "https://example.org/@/a/b/c").pusherUrl)
    }
}
