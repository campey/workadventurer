package app.workadventurer.app.ui

import app.workadventurer.app.session.Connection
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * The screens of the app (destinations of the one navigation graph) and the path each is reached by. [path] is what you
 * navigate to; [Route.PATTERN]s are what the nav host registers (with `{arguments}`).
 */
sealed interface Route {
    val path: String

    data object Join : Route { override val path = "join" }
    data object Users : Route { override val path = "users" }

    /** A bubble (by group id) or a map area (by `id ?: name`, as `WalkToArea`) with its people. */
    data class Conversation(val key: ConversationKey) : Route {
        override val path = when (key) {
            is ConversationKey.Bubble -> "conversation/bubble/${key.groupId}"
            is ConversationKey.AreaKey -> "conversation/area/${encode(key.key)}"
        }
        companion object { const val PATTERN = "conversation/{kind}/{id}" }
    }

    /** One person, by room user id. */
    data class User(val userId: Int) : Route {
        override val path = "user/$userId"
        companion object { const val PATTERN = "user/{userId}" }
    }
}

// URLEncoder writes a space as "+"; a path wants %20. Nothing else about it needs to differ.
private fun encode(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
private fun decode(s: String) = URLDecoder.decode(s, "UTF-8")

fun parseRoute(path: String): Route? {
    val parts = path.split('/')
    return when {
        path == "join" -> Route.Join
        path == "users" -> Route.Users
        parts.size == 2 && parts[0] == "user" -> parts[1].toIntOrNull()?.let { Route.User(it) }
        parts.size == 3 && parts[0] == "conversation" -> when (parts[1]) {
            "bubble" -> parts[2].toIntOrNull()?.let { Route.Conversation(ConversationKey.Bubble(it)) }
            "area" -> if (parts[2].isEmpty()) null else Route.Conversation(ConversationKey.AreaKey(decode(parts[2])))
            else -> null
        }
        else -> null
    }
}

/**
 * Join is the front door and stays up (showing progress) until the room is really joined; a drop that is reconnecting keeps
 * you in the room.
 */
fun routeFor(connection: Connection): Route = when (connection) {
    Connection.Connected, is Connection.Reconnecting -> Route.Users
    Connection.Disconnected, Connection.Connecting, is Connection.Failed -> Route.Join
}
