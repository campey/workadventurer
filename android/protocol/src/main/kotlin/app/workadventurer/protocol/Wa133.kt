package app.workadventurer.protocol

/** Frozen constants for WorkAdventure prod (v1.33.x). Mirrors src/adapters/wa-1.33.mjs. */
object Wa133 {
    const val DEFAULT_PUSHER = "https://pusher.workadventu.re"
    const val DEFAULT_ROOM = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space"
    const val DEFAULT_WOKA = "506a3a64-47a9-4587-b19b-2d1eb13f9790"

    /** Index 0 is what we send; newest first. A patch release may shift the hash: append, don't fork. */
    val API_VERSION_HASHES = listOf("05489a87", "bfd20fc4")
    const val ANONYM_LOGIN = "/anonymLogin"
    const val MAP = "/map"
}
