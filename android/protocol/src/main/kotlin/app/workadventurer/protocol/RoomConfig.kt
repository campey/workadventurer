package app.workadventurer.protocol

data class RoomConfig(
    val roomUrl: String = Wa133.DEFAULT_ROOM,
    val pusherUrl: String = Wa133.DEFAULT_PUSHER,
    val name: String,
    val wokaId: String = Wa133.DEFAULT_WOKA,
    val micOn: Boolean = false,
)
