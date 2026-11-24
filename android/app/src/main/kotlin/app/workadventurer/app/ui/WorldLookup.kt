package app.workadventurer.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import app.workadventurer.protocol.WorldMeta
import kotlinx.coroutines.delay

/** What a world says about itself (#108), looked up for the Join screen and the world panel. [looking] is true until both parts are in. */
@Stable
class WorldLookup {
    var meta by mutableStateOf<WorldMeta?>(null)
    var picture by mutableStateOf<ImageBitmap?>(null)
    var looking by mutableStateOf(false)
}

/**
 * Looks [roomUrl]'s world up [delayMs] after it stops changing (none while it isn't yet a room on the web). The words and the picture
 * are set together with nothing suspending between, so they appear in one step, after [WorldLookup.looking] has held a placeholder in
 * place. Needs nothing to join: a failed lookup leaves nothing to show.
 */
@Composable
fun rememberWorldLookup(
    roomUrl: String,
    delayMs: Long,
    loadWorldMeta: suspend (roomUrl: String) -> WorldMeta?,
    loadPicture: suspend (url: String) -> ImageBitmap?,
): WorldLookup {
    val state = remember { WorldLookup() }
    val lookup = worldLookupUrl(roomUrl)
    LaunchedEffect(lookup) {
        state.meta = null
        state.picture = null
        state.looking = lookup != null
        if (lookup != null) {
            if (delayMs > 0) delay(delayMs)
            val found = loadWorldMeta(lookup)
            val image = found?.thumbnail?.let { loadPicture(it) }
            state.meta = found
            state.picture = image
            state.looking = false
        }
    }
    return state
}
