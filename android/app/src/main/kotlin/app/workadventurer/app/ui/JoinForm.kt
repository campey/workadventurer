package app.workadventurer.app.ui

/** The last entry of the world list: clears the address and puts you in the field to type a new one. */
const val NEW_WORLD_LABEL = "+ New world"

/** What a screen reader says for the woka tile (Offline on the Join screen, Online in a room): it opens the picker (#108). */
fun wokaTileDescription(offline: Boolean) = "Your woka, ${if (offline) OFFLINE_LABEL else statusLabel(MY_STATUS)}. Opens the woka picker"

/** Shown in the preview instead of an initial until the picture is known or has loaded. */
const val WOKA_PREVIEW_PLACEHOLDER = "…"

/** Join needs a name and a world, and not to be joining already. */
fun canJoin(name: String, room: String, joining: Boolean) = !joining && name.isNotBlank() && room.isNotBlank()

/** The line under the Join button: what is missing, else what Join will do. */
fun joinExplainer(name: String, room: String) = when {
    name.isBlank() -> "Enter your name to join"
    room.isBlank() -> "Enter the world's address to join"
    else -> "Enter this world as ${name.trim()}"
}

/** In a room the name and woka are fixed for the connection, so changing either means rejoining; this says when the button is live. */
fun canRejoin(current: String, typed: String, wokaChanged: Boolean, connected: Boolean) =
    connected && typed.isNotBlank() && (typed.trim() != current.trim() || wokaChanged)

/** The button that replaces Leave in the world panel once your name or woka has changed. */
const val REJOIN_LABEL = "Rejoin the room"

/**
 * The warning shown above your name in the world panel while a rejoin is what applies a change: it names what changed. Null when
 * [canRejoin] is false (nothing changed, a blank name, or mid-reconnect), when Leave stays as it is.
 */
fun rejoinNotice(current: String, typed: String, wokaChanged: Boolean, connected: Boolean): String? {
    if (!canRejoin(current, typed, wokaChanged, connected)) return null
    val nameChanged = typed.trim() != current.trim()
    val what = when {
        nameChanged && wokaChanged -> "name and woka"
        nameChanged -> "name"
        else -> "woka"
    }
    return "⚠️ To update your $what you need to rejoin the room"
}
