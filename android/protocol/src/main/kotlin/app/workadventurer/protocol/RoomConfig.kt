package app.workadventurer.protocol

/** Staging (`play.staging.workadventu.re`, rolling master) has its own pusher and its own woka catalogue. */
object WaStaging {
    const val HOST = "play.staging.workadventu.re"
    const val PUSHER = "https://pusher.staging.workadventu.re"

    /** "Leo": a prod woka id is refused on staging with "invalid character texture". */
    const val DEFAULT_WOKA = "62b0c71f-f396-432b-a4c8-4d369d73e766"

    /** Staging runs WorkAdventure's master, so its hash is not prod's release hash. master@118dd84c (live-verified 2026-10-20). */
    const val API_VERSION_HASH = "d2d82672"
}

data class RoomConfig(
    val roomUrl: String = Wa133.DEFAULT_ROOM,
    val pusherUrl: String = Wa133.DEFAULT_PUSHER,
    val name: String,
    val wokaId: String = Wa133.DEFAULT_WOKA,
    val micOn: Boolean = false,
    /** Override only to probe a server build that has no adapter yet. */
    val apiVersionHash: String = Wa133.API_VERSION_HASHES[0],
    /**
     * How far around us we ask the server to stream players and bubbles (map pixels). The web client's own box is about
     * 1920x1080, which hides far bubbles; this covers a whole map (the biggest are ~6400x3840) so the Users screen is complete.
     * Measured on prod: 6000x4000 and 10000x8000 worked. (A first try at 20000x20000 showed nobody; not investigated.)
     */
    val viewportHalfWidth: Int = 8000,
    val viewportHalfHeight: Int = 6000,
) {
    companion object {
        /** The config for [roomUrl]: staging rooms get the staging pusher and woka, everything else is prod. A chosen [wokaId] replaces the default. */
        fun forRoom(name: String, roomUrl: String, micOn: Boolean = false, wokaId: String? = null): RoomConfig {
            val host = runCatching { java.net.URI(roomUrl.trim()).host }.getOrNull()
            val chosen = wokaId?.takeIf { it.isNotBlank() }
            return if (host == WaStaging.HOST) {
                RoomConfig(
                    roomUrl = roomUrl, name = name, micOn = micOn, pusherUrl = WaStaging.PUSHER, wokaId = chosen ?: WaStaging.DEFAULT_WOKA,
                    apiVersionHash = WaStaging.API_VERSION_HASH,
                )
            } else {
                RoomConfig(roomUrl = roomUrl, name = name, micOn = micOn, wokaId = chosen ?: Wa133.DEFAULT_WOKA)
            }
        }
    }
}
