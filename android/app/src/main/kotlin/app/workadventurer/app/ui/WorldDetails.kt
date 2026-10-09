package app.workadventurer.app.ui

import java.net.URI

/** What the Join screen and the world panel show about a world: its name, and its address split as the owner likes it. */
data class WorldDetails(val name: String, val host: String, val path: String)

private const val UNKNOWN_WORLD = "Unknown world"

/**
 * The details for a room URL. A room with a preset uses the preset's name; any other is named from the last part of its path
 * ("team-room" becomes "Team room"). The query and fragment (which can carry a token) are never part of what is shown.
 */
fun worldDetails(roomUrl: String): WorldDetails {
    val url = roomUrl.trim()
    val uri = runCatching { URI(url) }.getOrNull()
    val host = uri?.host.orEmpty()
    val path = uri?.rawPath.orEmpty().trimEnd('/')
    if (host.isEmpty() || path.isEmpty()) return WorldDetails(UNKNOWN_WORLD, "", "")
    val name = presetNameFor(url) ?: path.substringAfterLast('/').replace('-', ' ').replace('_', ' ')
        .trim().replaceFirstChar { it.uppercase() }.ifEmpty { UNKNOWN_WORLD }
    return WorldDetails(name, host, path)
}
