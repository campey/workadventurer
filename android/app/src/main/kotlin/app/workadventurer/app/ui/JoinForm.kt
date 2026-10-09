package app.workadventurer.app.ui

/** The last entry of the world list: clears the address and puts you in the field to type a new one. */
const val NEW_WORLD_LABEL = "+ New world"

/** Join needs a name and a world, and not to be joining already. */
fun canJoin(name: String, room: String, joining: Boolean) = !joining && name.isNotBlank() && room.isNotBlank()

/** The line under the Join button: what is missing, else what Join will do. */
fun joinExplainer(name: String, room: String) = when {
    name.isBlank() -> "Enter your name to join"
    room.isBlank() -> "Enter the world's address to join"
    else -> "Enter this world as ${name.trim()}"
}
