package app.workadventurer.protocol

/** Staging (`play.staging.workadventu.re`, rolling master) has its own pusher and its own woka catalogue. */
object WaStaging {
    const val HOST = "play.staging.workadventu.re"
    const val PUSHER = "https://pusher.staging.workadventu.re"

    /** "Leo": a prod woka id is refused on staging with "invalid character texture". */
    const val DEFAULT_WOKA = "62b0c71f-f396-432b-a4c8-4d369d73e766"
}

data class RoomConfig(
    val roomUrl: String = Wa133.DEFAULT_ROOM,
    val pusherUrl: String = Wa133.DEFAULT_PUSHER,
    val name: String,
    val wokaId: String = Wa133.DEFAULT_WOKA,
    val micOn: Boolean = false,
    /** Override only to probe a server build that has no adapter yet. */
    val apiVersionHash: String = Wa133.API_VERSION_HASHES[0],
    /** How far around us we ask the server to stream players and bubbles (map pixels). The web client's own box is this size. */
    val viewportHalfWidth: Int = 1920,
    val viewportHalfHeight: Int = 1080,
) {
    companion object {
        /** The config for [roomUrl]: staging rooms get the staging pusher and woka, everything else is prod. */
        fun forRoom(name: String, roomUrl: String): RoomConfig {
            val host = runCatching { java.net.URI(roomUrl.trim()).host }.getOrNull()
            return if (host == WaStaging.HOST) {
                RoomConfig(roomUrl = roomUrl, name = name, pusherUrl = WaStaging.PUSHER, wokaId = WaStaging.DEFAULT_WOKA)
            } else {
                RoomConfig(roomUrl = roomUrl, name = name)
            }
        }
    }
}
