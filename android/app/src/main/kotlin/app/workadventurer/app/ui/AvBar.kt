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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.Role
import app.workadventurer.app.audio.AudioDevice
import app.workadventurer.app.audio.DeviceKind
import app.workadventurer.app.audio.audioButtonDescription
import app.workadventurer.app.audio.micDeviceName

/**
 * The persistent bottom bar on every screen: mic and camera on the left, the audio and video sheet's three-dots on the right.
 * The mic is filled red when muted (as on the web); the camera is always off and drawn dim, because video isn't supported yet.
 */
@Composable
fun AvBar(
    state: AvBarState, onToggleMic: () -> Unit, onCamera: () -> Unit, onMore: () -> Unit,
    /** The device in use (its icon and name), and the button that switches device and opens the sheet. */
    audioDevice: AudioDevice? = null, onAudio: () -> Unit = {},
) {
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
        Spacer(Modifier.width(8.dp))
        IconButton(onClick = onAudio, modifier = Modifier.size(48.dp).semantics { contentDescription = audioButtonDescription(audioDevice) }) {
            Icon(deviceIcon(audioDevice?.kind), contentDescription = null)
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onMore, modifier = Modifier.size(48.dp).semantics { contentDescription = state.moreDescription }) {
            Icon(WaIcons.MoreVert, contentDescription = null)
        }
        Spacer(Modifier.width(4.dp))
    }
}

/** The audio and video sheet: the microphone (the one on the device in use), and the Device section listing every device with a tick on the one in use. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AvSheet(
    muted: Boolean, onDismiss: () -> Unit, sheetState: SheetState,
    devices: List<AudioDevice> = emptyList(), active: AudioDevice? = null, onPick: (AudioDevice) -> Unit = {},
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
        ) {
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
                    Text(micSheetText(muted, micDeviceName(active)), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (devices.isNotEmpty()) {
                Text(
                    "DEVICE", style = MaterialTheme.typography.labelLarge, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                    letterSpacing = androidx.compose.ui.unit.TextUnit(1.4f, androidx.compose.ui.unit.TextUnitType.Sp),
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f), modifier = Modifier.padding(start = 4.dp, top = 20.dp, bottom = 8.dp),
                )
                Column(
                    Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(16.dp))
                        .selectableGroup(),
                ) {
                    devices.forEach { d ->
                        val inUse = d.id == active?.id
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 64.dp)
                                .selectable(selected = inUse, role = Role.RadioButton, onClick = { onPick(d) })
                                .padding(horizontal = 16.dp, vertical = 8.dp)
                                .semantics { contentDescription = if (inUse) "${d.name}, in use" else d.name },
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(deviceIcon(d.kind), contentDescription = null)
                            Column(Modifier.weight(1f)) {
                                Text(d.name, style = MaterialTheme.typography.titleMedium)
                                Text(deviceSubtitle(d), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (inUse) Icon(WaIcons.Check, contentDescription = null, tint = androidx.compose.ui.graphics.Color(0xFF68E97A))
                        }
                    }
                }
            }
        }
    }
}

private fun deviceIcon(kind: DeviceKind?) = when (kind) {
    DeviceKind.Earpiece -> WaIcons.Earpiece
    DeviceKind.Bluetooth -> WaIcons.Bluetooth
    DeviceKind.Wired, DeviceKind.Usb -> WaIcons.Headset
    DeviceKind.Speaker, null -> WaIcons.Speaker
}

private fun deviceSubtitle(d: AudioDevice) = when (d.kind) {
    DeviceKind.Speaker -> "Speaker and the phone's microphone"
    DeviceKind.Earpiece -> "Earpiece and the phone's microphone"
    DeviceKind.Bluetooth -> "Bluetooth · speaker and microphone"
    DeviceKind.Wired -> "Plugged in · speaker and microphone"
    DeviceKind.Usb -> "USB · speaker and microphone"
}
