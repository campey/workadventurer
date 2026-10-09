package app.workadventurer.app.ui

import app.workadventurer.app.session.Connection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class RoutesTest {
    @Test
    fun everyRouteRoundTripsThroughItsPath() {
        val all = listOf(
            Route.Join, Route.Users, Route.User(42),
            Route.Conversation(ConversationKey.Bubble(17)),
            Route.Conversation(ConversationKey.AreaKey("coffee-table-1")),
        )
        for (r in all) assertEquals(r, parseRoute(r.path), r.path)
    }

    // Area keys are an id or a name from the map: spaces, slashes and non-latin text must survive being part of a path.
    @Test
    fun anAreaKeyWithAwkwardCharactersSurvives() {
        for (key in listOf("Lean Coffee Table 1", "a/b/c", "100% fun?", "Café ☕", "(unnamed)", "x#y&z")) {
            val r = Route.Conversation(ConversationKey.AreaKey(key))
            assertEquals(r, parseRoute(r.path), key)
            assertEquals(false, r.path.removePrefix("conversation/area/").contains('/'), "the key must not add path segments: ${r.path}")
        }
    }

    @Test
    fun theStaticPathsAreWhatTheNavHostRegisters() {
        assertEquals("join", Route.Join.path)
        assertEquals("users", Route.Users.path)
        assertEquals("user/{userId}", Route.User.PATTERN)
        assertEquals("conversation/{kind}/{id}", Route.Conversation.PATTERN)
    }

    @Test
    fun garbageIsNotARoute() {
        for (p in listOf("", "nowhere", "user/abc", "user/", "conversation/bubble/x", "conversation/room/3", "conversation/bubble", "users/extra")) {
            assertNull(parseRoute(p), p)
        }
    }

    // Join is the front door and stays up (showing progress) until the room is really joined; a drop that is reconnecting
    // keeps you in the room.
    @Test
    fun theScreenFollowsTheConnection() {
        assertEquals(Route.Join, routeFor(Connection.Disconnected))
        assertEquals(Route.Join, routeFor(Connection.Failed("nope")))
        assertEquals(Route.Join, routeFor(Connection.Connecting))
        assertEquals(Route.Users, routeFor(Connection.Connected))
        assertEquals(Route.Users, routeFor(Connection.Reconnecting(2, 1000)))
    }
}
