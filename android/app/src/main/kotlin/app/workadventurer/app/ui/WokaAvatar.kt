package app.workadventurer.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.protocol.Texture

/** The one woka picture builder for the app, provided at the root (screens only read it). */
val LocalWokaLoader = compositionLocalOf<WokaLoader?> { null }

/**
 * A person's picture: their woka when it has loaded (pixel art, scaled up without smoothing), else their initial on a colour
 * that stays the same for them. A status dot sits on the corner when [status] is given. Decorative: whatever shows it names
 * the person and their status in text, so this is hidden from TalkBack ([clearAndSetSemantics]) rather than read twice.
 */
@Composable
fun WokaAvatar(
    textures: List<Texture>,
    name: String,
    size: Dp,
    modifier: Modifier = Modifier,
    status: AvailabilityStatus? = null,
    dim: Boolean = false,
    /** Shown instead of the initial while there is no picture (the Join preview uses an ellipsis). */
    placeholder: String? = null,
    /** A grey dot (not in a world yet) instead of a status colour. */
    offline: Boolean = false,
    /** No coloured tile behind the picture (and a light placeholder): for a container that already has its own background. */
    plain: Boolean = false,
) {
    val loader = LocalWokaLoader.current
    val picture by produceState<ImageBitmap?>(null, WokaSprite.cacheKey(textures), loader) {
        value = loader?.load(textures)
    }
    val shape = RoundedCornerShape(size / 3.5f)
    Box(modifier.size(size).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        Box(
            Modifier.fillMaxSize().clip(shape).background(if (plain) Color.Transparent else Color(placeholderColor(name))).alpha(if (dim) 0.5f else 1f),
            contentAlignment = Alignment.Center,
        ) {
            val p = picture
            if (p != null) {
                Image(p, contentDescription = null, contentScale = ContentScale.Fit, filterQuality = FilterQuality.None, modifier = Modifier.fillMaxSize())
            } else {
                Text(placeholder ?: initialOf(name), color = if (plain) MaterialTheme.colorScheme.onSurface else Color(0xFF0B1B32), fontSize = (size.value * 0.42f).sp, style = MaterialTheme.typography.titleMedium)
            }
        }
        if (status != null || offline) {
            val dot = (size.value * 0.34f).coerceAtLeast(10f).dp
            Box(
                Modifier.align(Alignment.BottomEnd).size(dot).clip(CircleShape)
                    .background(Color(if (offline || status == null) OFFLINE_COLOR else statusColor(status)))
                    .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape),
            )
        }
    }
}
