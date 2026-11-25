package app.workadventurer.app.ui
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.semantics.Role


import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

val DONE_COLOR = androidx.compose.ui.graphics.Color(0xFF68E97A)

/**
 * The big pill at the bottom of a screen with a one-line explainer under it. Joining is always the blue one in this spot;
 * leaving is the same pill outlined in the danger colour ([danger]), a quieter choice is outlined in the neutral colour.
 */
@Composable
fun PrimaryAction(
    label: String,
    explainer: String,
    onClick: () -> Unit,
    description: String = label,
    enabled: Boolean = true,
    danger: Boolean = false,
    quiet: Boolean = false,
    done: Boolean = false,
    /** An icon before the label of a [danger] button; [flipIcon] mirrors it left to right. */
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    flipIcon: Boolean = false,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).semantics { contentDescription = description }
        if (done) {
            // A state, not a button: the green pill with a tick that Join turns into once you are in.
            Button(
                onClick = onClick, enabled = false, modifier = modifier, shape = RoundedCornerShape(32.dp),
                colors = ButtonDefaults.buttonColors(disabledContainerColor = DONE_COLOR, disabledContentColor = androidx.compose.ui.graphics.Color(0xFF0B1B32)),
            ) {
                Icon(WaIcons.Check, contentDescription = null, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(10.dp))
                Text(label, style = MaterialTheme.typography.titleMedium)
            }
        } else if (danger) {
            OutlinedButton(
                onClick = onClick, enabled = enabled, modifier = modifier, shape = RoundedCornerShape(32.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) {
                if (icon != null) {
                    Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp).then(if (flipIcon) Modifier.scale(scaleX = -1f, scaleY = 1f) else Modifier))
                    Spacer(Modifier.width(10.dp))
                }
                Text(label, style = MaterialTheme.typography.titleMedium)
            }
        } else if (quiet) {
            Button(
                onClick = onClick, enabled = enabled, modifier = modifier, shape = RoundedCornerShape(32.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) { Text(label, style = MaterialTheme.typography.titleMedium) }
        } else {
            Button(onClick = onClick, enabled = enabled, modifier = modifier, shape = RoundedCornerShape(32.dp)) {
                Text(label, style = MaterialTheme.typography.titleMedium)
            }
        }
        if (explainer.isNotEmpty()) Text(
            explainer, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * A world's icon, name, domain and path. [plain] drops the card (border, background, padding) for a surface that already is
 * the right colour, such as the world panel (icon above its words); the Join screen uses the bordered tile, with the words
 * beside the icon.
 */
@Composable
fun WorldInfo(details: WorldDetails, plain: Boolean = false, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(16.dp)
    val card = if (plain) Modifier else Modifier.border(1.dp, MaterialTheme.colorScheme.outline, shape)
    val icon: @Composable () -> Unit = {
        Box(
            Modifier.size(64.dp).border(3.dp, MaterialTheme.colorScheme.onSurface, RoundedCornerShape(18.dp)),
            contentAlignment = Alignment.Center,
        ) { Icon(WaIcons.WorldDefault, contentDescription = null, modifier = Modifier.size(34.dp)) }
    }
    val words: @Composable () -> Unit = {
        Text(details.name, style = MaterialTheme.typography.titleLarge)
        if (details.host.isNotEmpty()) {
            Text(details.host, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            Text(details.path, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f))
        }
    }
    Surface(
        modifier = modifier.fillMaxWidth().then(card),
        shape = shape,
        color = if (plain) androidx.compose.ui.graphics.Color.Transparent else MaterialTheme.colorScheme.surface,
    ) {
        if (plain) {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                icon()
                Column { words() }
            }
        } else {
            Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top) {
                icon()
                Column(Modifier.weight(1f)) { words() }
            }
        }
    }
}

/**
 * What a world says about itself under its title tile (#108), shown only once it is all there: while [loading] a placeholder tile
 * stands in. Its map [picture] is a tile of its own, with the [description] on dark
 * translucent glass over the bottom of it. A world with a description but no picture gets the description in a plain tile; one with
 * neither gets nothing. The Join screen scrolls this above its pinned name and Join, so its size changing moves nothing else.
 */
@Composable
fun WorldPreview(
    description: String?, picture: androidx.compose.ui.graphics.ImageBitmap?, modifier: Modifier = Modifier,
    /** True while the world is being looked up: a placeholder tile stands in, and the real one replaces it in one step. */
    loading: Boolean = false,
) {
    val shape = RoundedCornerShape(16.dp)
    if (loading) {
        Box(
            modifier.fillMaxWidth().height(180.dp).clip(shape).border(1.dp, MaterialTheme.colorScheme.outline, shape)
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                .semantics { contentDescription = "Loading the world's preview" },
            contentAlignment = Alignment.Center,
        ) { androidx.compose.material3.CircularProgressIndicator(Modifier.size(32.dp), strokeWidth = 3.dp) }
        return
    }
    if (picture == null) {
        if (description != null) Text(
            description, style = MaterialTheme.typography.bodyMedium,
            modifier = modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outline, shape).padding(16.dp),
        )
        return
    }
    Box(modifier.fillMaxWidth().heightIn(min = 180.dp).clip(shape).border(1.dp, MaterialTheme.colorScheme.outline, shape)) {
        androidx.compose.foundation.Image(
            picture, contentDescription = "Preview of the world", modifier = Modifier.matchParentSize(),
            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
        )
        if (description != null) {
            // The map shows above; the words sit on glass below it. Dark enough to read over a bright or a busy map.
            Column(Modifier.fillMaxWidth()) {
                Spacer(Modifier.height(140.dp))
                Text(
                    description, style = MaterialTheme.typography.bodyMedium, color = androidx.compose.ui.graphics.Color.White,
                    modifier = Modifier.fillMaxWidth().padding(8.dp).clip(RoundedCornerShape(10.dp))
                        .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.76f)).padding(12.dp),
                )
            }
        }
    }
}

/** Your woka in a tile like the world's: same border, corners and background, the picture just inside it. Tapping it chooses another. */
@Composable
fun WokaTile(layers: List<app.workadventurer.protocol.Texture>, name: String, onClick: () -> Unit, description: String, offline: Boolean) {
    Box(
        Modifier.size(56.dp).border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(16.dp))
            .clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surface).clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) { WokaAvatar(layers, name.ifBlank { "?" }, 48.dp, offline = offline, plain = true, placeholder = WOKA_PREVIEW_PLACEHOLDER) }
}
