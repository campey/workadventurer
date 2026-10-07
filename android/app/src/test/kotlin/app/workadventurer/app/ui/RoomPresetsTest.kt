package app.workadventurer.app.ui

import app.workadventurer.protocol.Wa133
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RoomPresetsTest {
    @Test
    fun theFirstRoomIsTheDefaultSoANewInstallStillJoinsWhatItDidBefore() {
        assertEquals(Wa133.DEFAULT_ROOM, ROOM_PRESETS.first().url)
    }

    @Test
    fun theFrequentRoomsAreThere() {
        val urls = ROOM_PRESETS.map { it.url }
        assertTrue("https://play.workadventu.re/@/afrolabs/afrolabs/open-space" in urls)
        assertTrue("https://play.workadventu.re/@/levelup-npc/lean-iterator/campus" in urls)
    }

    // A malformed preset would fail only at join time, in front of the user; catch it here.
    @Test
    fun everyPresetIsANamedUniqueWorkAdventureRoomLink() {
        assertEquals(ROOM_PRESETS.size, ROOM_PRESETS.map { it.url }.toSet().size, "duplicate url")
        assertEquals(ROOM_PRESETS.size, ROOM_PRESETS.map { it.name }.toSet().size, "duplicate name")
        for (p in ROOM_PRESETS) {
            assertTrue(p.name.isNotBlank(), "blank name for ${p.url}")
            assertTrue(Regex("""^https://play\.workadventu\.re/@/[^/\s]+/[^/\s]+/[^/\s]+$""").matches(p.url), "not a room link: ${p.url}")
        }
    }

    @Test
    fun theNameOfAKnownRoomIsFoundForTheUrlTypedInTheField() {
        assertEquals("Lean Iterator campus", presetNameFor("https://play.workadventu.re/@/levelup-npc/lean-iterator/campus"))
        assertEquals("Lean Iterator campus", presetNameFor("  https://play.workadventu.re/@/levelup-npc/lean-iterator/campus  "))
        assertEquals(null, presetNameFor("https://play.workadventu.re/@/someone/else/room"))
    }
}
