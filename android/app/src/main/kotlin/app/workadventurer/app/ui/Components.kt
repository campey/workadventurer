package app.workadventurer.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
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
            ) { Text(label, style = MaterialTheme.typography.titleMedium) }
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
        Text(
            explainer, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * A world's icon, name, domain and path. [plain] drops the card (border, background, padding) for a surface that already is
 * the right colour, such as the world panel; the Join screen uses the bordered tile.
 */
@Composable
fun WorldInfo(details: WorldDetails, plain: Boolean = false, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(16.dp)
    val card = if (plain) Modifier else Modifier
        .border(1.dp, MaterialTheme.colorScheme.outline, shape)
    Surface(
        modifier = modifier.fillMaxWidth().then(card),
        shape = shape,
        color = if (plain) androidx.compose.ui.graphics.Color.Transparent else MaterialTheme.colorScheme.surface,
    ) {
        Column(Modifier.padding(if (plain) 0.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(
                Modifier.size(64.dp).border(3.dp, MaterialTheme.colorScheme.onSurface, RoundedCornerShape(18.dp)),
                contentAlignment = Alignment.Center,
            ) { Icon(WaIcons.WorldDefault, contentDescription = null, modifier = Modifier.size(34.dp)) }
            Column {
                Text(details.name, style = MaterialTheme.typography.titleLarge)
                if (details.host.isNotEmpty()) {
                    Text(details.host, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                    Text(details.path, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f))
                }
            }
        }
    }
}
