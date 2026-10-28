package app.workadventurer.app.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class WorldDetailsTest {
    @Test
    fun aKnownRoomUsesItsPresetName() {
        assertEquals(
            WorldDetails("Afrolabs open space", "play.workadventu.re", "/@/afrolabs/afrolabs/open-space"),
            worldDetails("https://play.workadventu.re/@/afrolabs/afrolabs/open-space"),
        )
        assertEquals("WorkAdventure staging village", worldDetails("https://play.staging.workadventu.re/@/tcm/workadventure/wa-village").name)
    }

    @Test
    fun surroundingSpacesAreIgnored() {
        assertEquals("Lean Iterator campus", worldDetails("  https://play.workadventu.re/@/levelup-npc/lean-iterator/campus  ").name)
    }

    // A room we have no preset for is named from the last part of its path.
    @Test
    fun anUnknownRoomIsNamedFromItsPath() {
        val d = worldDetails("https://play.workadventu.re/@/someone/else/team-room")
        assertEquals("Team room", d.name)
        assertEquals("play.workadventu.re", d.host)
        assertEquals("/@/someone/else/team-room", d.path)
    }

    @Test
    fun theQueryAndFragmentAreNotPartOfThePath() {
        val d = worldDetails("https://play.workadventu.re/@/a/b/c?token=secret#start")
        assertEquals("/@/a/b/c", d.path)
        assertEquals("C", d.name)
    }

    // "Share link to room" hands the address to other apps: never with a query or fragment, which can carry a login token.
    @Test
    fun theSharedLinkIsTheRoomAddressWithoutAnyToken() {
        assertEquals("https://play.workadventu.re/@/a/b/c", shareableRoomUrl("  https://play.workadventu.re/@/a/b/c?token=secret#start "))
        assertEquals("https://play.staging.workadventu.re/@/tcm/workadventure/wa-village", shareableRoomUrl("https://play.staging.workadventu.re/@/tcm/workadventure/wa-village"))
    }

    @Test
    fun thereIsNothingToShareWithoutARoom() {
        assertEquals("", shareableRoomUrl(""))
        assertEquals("", shareableRoomUrl("not a url"))
        assertEquals("", shareableRoomUrl("https://play.workadventu.re"))
    }

    @Test
    fun somethingThatIsNotAUrlStillGivesSomethingToShow() {
        assertEquals(WorldDetails("Unknown world", "", ""), worldDetails("not a url"))
        assertEquals(WorldDetails("Unknown world", "", ""), worldDetails(""))
        assertEquals("Unknown world", worldDetails("https://play.workadventu.re").name) // a host with no room
    }
}
