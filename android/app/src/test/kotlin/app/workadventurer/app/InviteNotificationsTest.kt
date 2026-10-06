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

    @Test
    fun oneNotificationPerPendingInviteNamingTheSender() {
        val n = inviteNotifications(listOf(ada, bob))
        assertEquals(2, n.size)
        assertEquals("Ada", n[0].title)
        assertEquals("Ada invited you over", n[0].text)
        assertEquals("Bob", n[1].title)
    }

    @Test
    fun aBlankSenderNameStillReadsSensibly() {
        val n = inviteNotifications(listOf(ada.copy(senderName = " ")))
        assertEquals("Someone invited you over", n.single().text)
    }

    @Test
    fun noInvitesMeansNoNotifications() {
        assertTrue(inviteNotifications(emptyList()).isEmpty())
    }

    @Test
    fun idsAreStablePerSenderDistinctBetweenSendersAndNeverTheServiceNotification() {
        val a1 = inviteNotifications(listOf(ada)).single().id
        val a2 = inviteNotifications(listOf(bob, ada)).last().id
        assertEquals(a1, a2, "re-posting the same invite must update the same notification")
        assertNotEquals(a1, inviteNotifications(listOf(bob)).single().id)
        assertTrue(a1 > PRESENCE_NOTIFICATION_ID, "must not collide with the foreground-service notification")
    }

    // The uuid is the account email for logged-in players: it must not reach anything shown or stored by the system.
    @Test
    fun theSenderUuidNeverAppearsInANotification() {
        for (n in inviteNotifications(listOf(ada, bob))) {
            assertTrue("example.com" !in n.title + n.text, n.toString())
        }
    }

    @Test
    fun staleIdsAreThePostedOnesNoLongerPending() {
        val current = inviteNotifications(listOf(bob))
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
