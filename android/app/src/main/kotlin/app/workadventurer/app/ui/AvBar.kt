package app.workadventurer.app.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.material3.SheetState

/**
 * The persistent bottom bar on every screen: mic and camera on the left, the audio and video sheet's three-dots on the right.
 * The mic is filled red when muted (as on the web); the camera is always off and drawn dim, because video isn't supported yet.
 */
@Composable
fun AvBar(state: AvBarState, onToggleMic: () -> Unit, onCamera: () -> Unit, onMore: () -> Unit) {
    BottomAppBar(containerColor = MaterialTheme.colorScheme.surface, contentColor = MaterialTheme.colorScheme.onSurface) {
        Spacer(Modifier.width(4.dp))
        IconToggleButton(
            checked = state.micMuted,
            onCheckedChange = { onToggleMic() },
            colors = IconButtonDefaults.iconToggleButtonColors(
                checkedContainerColor = MaterialTheme.colorScheme.error,
                checkedContentColor = MaterialTheme.colorScheme.onError,
            ),
            modifier = Modifier.size(48.dp).semantics {
                contentDescription = state.micDescription
                liveRegion = LiveRegionMode.Polite
            },
        ) { Icon(if (state.micMuted) WaIcons.MicOff else WaIcons.MicOn, contentDescription = null) }
        Spacer(Modifier.width(8.dp))
        // Present but off: dim, announced as unavailable, and a tap says why.
        IconButton(
            onClick = onCamera,
            modifier = Modifier.size(48.dp).semantics {
                contentDescription = state.cameraDescription
                disabled()
            },
        ) { Icon(WaIcons.CameraOff, contentDescription = null, tint = WaColors.DisabledIcon) }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onMore, modifier = Modifier.size(48.dp).semantics { contentDescription = state.moreDescription }) {
            Icon(WaIcons.MoreVert, contentDescription = null)
        }
        Spacer(Modifier.width(4.dp))
    }
}

/** The audio and video sheet. For now it shows the microphone and nothing else; device switching comes with the telephony work (#85). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AvSheet(muted: Boolean, onDismiss: () -> Unit, sheetState: SheetState) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 20.dp, end = 20.dp, bottom = 24.dp)) {
            Text(AUDIO_VIDEO_SHEET_TITLE, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 4.dp, bottom = 16.dp))
            Row(
                Modifier.fillMaxWidth().heightIn(min = 72.dp)
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(16.dp))
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (muted) WaIcons.MicOff else WaIcons.MicOn, contentDescription = null)
                Column {
                    Text("Microphone", style = MaterialTheme.typography.titleMedium)
                    Text(micSheetText(muted), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
