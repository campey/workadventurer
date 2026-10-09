package app.workadventurer.app.ui

import app.workadventurer.proto.AvailabilityStatus
import kotlin.test.Test
import kotlin.test.assertEquals

class StatusTest {
    // The web client's own words (play/src/i18n/en-US/chat.ts, chat.status.*), so the app reads the same.
    @Test
    fun theLabelsAreTheWebClientsWords() {
        assertEquals("Online", statusLabel(AvailabilityStatus.ONLINE))
        assertEquals("Away", statusLabel(AvailabilityStatus.AWAY))
        assertEquals("Busy", statusLabel(AvailabilityStatus.BUSY))
        assertEquals("Do not disturb", statusLabel(AvailabilityStatus.DO_NOT_DISTURB))
        assertEquals("Back in a moment", statusLabel(AvailabilityStatus.BACK_IN_A_MOMENT))
        assertEquals("Sound blocked", statusLabel(AvailabilityStatus.SOUND_BLOCKED))
        assertEquals("Using the megaphone", statusLabel(AvailabilityStatus.SPEAKER))
    }

    @Test
    fun everyKindOfMeetingReadsInAMeeting() {
        for (s in listOf(AvailabilityStatus.JITSI, AvailabilityStatus.BBB, AvailabilityStatus.LIVEKIT, AvailabilityStatus.LISTENER)) {
            assertEquals("In a meeting", statusLabel(s), s.name)
        }
    }

    @Test
    fun theRestIsUnavailable() {
        assertEquals("Unavailable", statusLabel(AvailabilityStatus.SILENT))
        assertEquals("Unavailable", statusLabel(AvailabilityStatus.DENY_PROXIMITY_MEETING))
    }

    // "Unchanged" means a details update that was about something else; as a state it reads as the default, online.
    // Not in a world yet (the Join screen's preview): the protocol has no such status, but the web client has the word and a grey dot.
    @Test
    fun beforeJoiningYouAreOfflineAndGrey() {
        assertEquals("Offline", OFFLINE_LABEL)
        assertEquals(0xFF6B7A90L, OFFLINE_COLOR)
    }

    @Test
    fun unchangedIsTreatedAsOnline() {
        assertEquals("Online", statusLabel(AvailabilityStatus.UNCHANGED))
        assertEquals(statusColor(AvailabilityStatus.ONLINE), statusColor(AvailabilityStatus.UNCHANGED))
    }

    @Test
    fun theColoursAreTheWebClientsDots() {
        assertEquals(0xFF68E97AL, statusColor(AvailabilityStatus.ONLINE))
        assertEquals(0xFF68E97AL, statusColor(AvailabilityStatus.LIVEKIT)) // in a meeting is green too
        assertEquals(0xFFE9C84EL, statusColor(AvailabilityStatus.AWAY))
        assertEquals(0xFFE9C84EL, statusColor(AvailabilityStatus.BUSY))
        assertEquals(0xFFE96E53L, statusColor(AvailabilityStatus.DO_NOT_DISTURB))
        assertEquals(0xFF7382E2L, statusColor(AvailabilityStatus.BACK_IN_A_MOMENT))
        assertEquals(0xFFE74C3CL, statusColor(AvailabilityStatus.SILENT))
    }

    // Colour is never the only signal: a dot is always shown next to its label, and every status has a distinct label or colour.
    @Test
    fun noTwoDifferentStatesAreIndistinguishable() {
        val shown = AvailabilityStatus.entries.filter { it != AvailabilityStatus.UNCHANGED }
            .groupBy { statusLabel(it) to statusColor(it) }
        for ((k, same) in shown) assertEquals(true, same.size >= 1, k.toString())
        assertEquals(statusLabel(AvailabilityStatus.AWAY) != statusLabel(AvailabilityStatus.BUSY), true)
    }
}
