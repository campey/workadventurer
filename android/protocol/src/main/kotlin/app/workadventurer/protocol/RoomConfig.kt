package app.workadventurer.protocol

data class RoomConfig(
    val roomUrl: String = Wa133.DEFAULT_ROOM,
    val pusherUrl: String = Wa133.DEFAULT_PUSHER,
    val name: String,
    val wokaId: String = Wa133.DEFAULT_WOKA,
    val micOn: Boolean = false,
    /** Override only to probe a server build that has no adapter yet. */
    val apiVersionHash: String = Wa133.API_VERSION_HASHES[0],
)
