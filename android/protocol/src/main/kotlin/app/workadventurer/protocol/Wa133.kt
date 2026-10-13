package app.workadventurer.protocol

/** Frozen constants for WorkAdventure prod (v1.33.x). Mirrors src/adapters/wa-1.33.mjs. */
object Wa133 {
    const val DEFAULT_PUSHER = "https://pusher.workadventu.re"
    const val DEFAULT_ROOM = "https://play.workadventu.re/@/afrolabs/afrolabs/open-space"
    const val DEFAULT_WOKA = "506a3a64-47a9-4587-b19b-2d1eb13f9790"

    /**
     * Index 0 is what we send; newest first. b82fc568 is prod v1.34.1 (2026-10-11; messages.proto is byte-identical to
     * 1.34.0, only the analytics JSON that the hash also covers changed). 23c8eb8c is v1.34.0. Prod answers a stale hash
     * with an "a new version is available" error screen, which the app shows as "couldn't join... please refresh".
     * The 1.33 proto still decodes fine against 1.34.x (live-verified).
     */
    val API_VERSION_HASHES = listOf("b82fc568", "23c8eb8c", "05489a87", "bfd20fc4")
    const val ANONYM_LOGIN = "/anonymLogin"
    const val MAP = "/map"
}
