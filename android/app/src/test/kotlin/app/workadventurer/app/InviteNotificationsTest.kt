package app.workadventurer.app

import app.workadventurer.protocol.Invite
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class InviteNotificationsTest {
    private val ada = Invite("ada@example.com", "Ada", 1, "https://play/room")
    private val bob = Invite("bob@example.com", "Bob", 2, "https://play/room")

    // Stand-ins for WorkAdventure's translated strings (R.string.wa_invite_title / wa_invite_default_responder).
    private fun notifications(vararg invites: Invite) =
        inviteNotifications(invites.toList(), defaultName = "The user") { name -> "$name invites you to join the meeting" }

    @Test
    fun oneNotificationPerPendingInviteNamingTheSenderInWorkAdventuresWords() {
        val n = notifications(ada, bob)
        assertEquals(2, n.size)
        assertEquals("Ada", n[0].title)
        assertEquals("Ada invites you to join the meeting", n[0].text)
        assertEquals("Bob", n[1].title)
    }

    @Test
    fun aBlankSenderNameUsesTheDefaultName() {
        val n = notifications(ada.copy(senderName = " ")).single()
        assertEquals("The user", n.title)
        assertEquals("The user invites you to join the meeting", n.text)
    }

    @Test
    fun noInvitesMeansNoNotifications() {
        assertTrue(notifications().isEmpty())
    }

    @Test
    fun idsAreStablePerSenderDistinctBetweenSendersAndNeverTheServiceNotification() {
        val a1 = notifications(ada).single().id
        val a2 = notifications(bob, ada).last().id
        assertEquals(a1, a2, "re-posting the same invite must update the same notification")
        assertNotEquals(a1, notifications(bob).single().id)
        assertTrue(a1 > PRESENCE_NOTIFICATION_ID, "must not collide with the foreground-service notification")
    }

    // The uuid is the account email for logged-in players: it must not reach anything shown or stored by the system.
    @Test
    fun theSenderUuidNeverAppearsInANotification() {
        for (n in notifications(ada, bob)) {
            assertTrue("example.com" !in n.title + n.text, n.toString())
        }
    }

    @Test
    fun staleIdsAreThePostedOnesNoLongerPending() {
        val current = notifications(bob)
        val posted = setOf(inviteNotificationId(ada.senderUuid), inviteNotificationId(bob.senderUuid))
        assertEquals(setOf(inviteNotificationId(ada.senderUuid)), staleInviteNotificationIds(posted, current))
        assertTrue(staleInviteNotificationIds(emptySet(), current).isEmpty())
    }

    @Test
    fun aNotificationIdResolvesBackToItsInviteAndAnUnknownOneToNull() {
        val id = inviteNotificationId(bob.senderUuid)
        assertEquals(bob, inviteForNotificationId(listOf(ada, bob), id))
        assertNull(inviteForNotificationId(listOf(ada), id))
    }
}
