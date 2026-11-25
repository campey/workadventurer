package app.workadventurer.app.ui

/** What a person's screen says when that person leaves the room while it is open: who it was (as last seen), and what happened. */
fun personGoneNotice(lastName: String?): String =
    lastName?.takeIf { it.isNotBlank() }?.let { "$it has left the room" } ?: "This person has left the room"

/** What a conversation screen says when its bubble dissolves under it (an area never goes away, so this is a bubble). */
fun conversationGoneNotice(): String = "This bubble has ended: everyone has left it"
