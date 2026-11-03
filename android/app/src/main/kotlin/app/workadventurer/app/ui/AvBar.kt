package app.workadventurer.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.Role
import app.workadventurer.app.audio.AudioDevice
import app.workadventurer.app.audio.DeviceKind
import app.workadventurer.app.audio.audioButtonDescription
import app.workadventurer.app.net.NETWORK_BUTTON_DESCRIPTION

/**
 * The persistent bottom bar on every screen: mic and the audio device, a divider, then the camera on the left; the audio and video sheet's three-dots on the right.
 * The mic is filled red when muted (as on the web); the camera is always off and drawn dim, because video isn't supported yet.
 */
@Composable
fun AvBar(
    state: AvBarState, onToggleMic: () -> Unit, onCamera: () -> Unit,
    /** The device in use (its icon and name), and the button that switches device and opens the sheet. */
    audioDevice: AudioDevice? = null, onAudio: () -> Unit = {},
    onNetwork: () -> Unit = {},
) {
    // Every button is a filled circle, so they all read as buttons; the mic's circle goes red when muted.
    val circle = IconButtonDefaults.iconButtonColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)
    BottomAppBar(containerColor = MaterialTheme.colorScheme.surface, contentColor = MaterialTheme.colorScheme.onSurface) {
        Spacer(Modifier.width(4.dp))
        IconToggleButton(
            checked = state.micMuted,
            onCheckedChange = { onToggleMic() },
            colors = IconButtonDefaults.iconToggleButtonColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                checkedContainerColor = MaterialTheme.colorScheme.error,
                checkedContentColor = MaterialTheme.colorScheme.onError,
            ),
            modifier = Modifier.size(48.dp).semantics {
                contentDescription = state.micDescription
                liveRegion = LiveRegionMode.Polite
            },
        ) { Icon(if (state.micMuted) WaIcons.MicOff else WaIcons.MicOn, contentDescription = null) }
        Spacer(Modifier.width(8.dp))
        // Audio first (the mic, then the device it uses), a divider, then video.
        IconButton(onClick = onAudio, colors = circle, modifier = Modifier.size(48.dp).semantics { contentDescription = audioButtonDescription(audioDevice) }) {
            Icon(deviceIcon(audioDevice?.kind), contentDescription = null)
        }
        Spacer(Modifier.width(12.dp))
        Box(Modifier.width(1.dp).height(28.dp).background(MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)))
        Spacer(Modifier.width(12.dp))
        // Present but off: dim, announced as unavailable, and a tap says why.
        IconButton(
            onClick = onCamera,
            colors = circle,
            modifier = Modifier.size(48.dp).semantics {
                contentDescription = state.cameraDescription
                disabled()
            },
        ) { Icon(WaIcons.CameraOff, contentDescription = null, tint = WaColors.DisabledIcon) }
        Spacer(Modifier.weight(1f))
        // At the far right: connections and data used, the Network sheet.
        IconButton(onClick = onNetwork, colors = circle, modifier = Modifier.size(48.dp).semantics { contentDescription = NETWORK_BUTTON_DESCRIPTION }) {
            Icon(WaIcons.Network, contentDescription = null)
        }
        Spacer(Modifier.width(4.dp))
    }
}

/**
 * The audio sheet: the Device section listing every device with the one in use filled green. Audio only (video gets its own sheet from
 * the camera button), and no mute row: the bar's mic does that. The microphone is the one on the device in use, as each row says.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AvSheet(
    onDismiss: () -> Unit, sheetState: SheetState,
    devices: List<AudioDevice> = emptyList(), active: AudioDevice? = null, onPick: (AudioDevice) -> Unit = {},
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 24.dp)
                .semantics { paneTitle = AUDIO_SHEET_TITLE },
        ) {
            if (devices.isNotEmpty()) {
                SectionLabel("DEVICE", first = true)
                Column(
                    Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(16.dp))
                        .padding(4.dp).selectableGroup(),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    devices.forEach { d ->
                        val inUse = d.id == active?.id
                        // The device in use is the whole row in green, dark text on it: unmistakable at a glance.
                        val content = if (inUse) DEVICE_IN_USE_CONTENT else MaterialTheme.colorScheme.onSurface
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 56.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (inUse) DEVICE_IN_USE else androidx.compose.ui.graphics.Color.Transparent)
                                .selectable(selected = inUse, role = Role.RadioButton, onClick = { onPick(d) })
                                .padding(horizontal = 12.dp, vertical = 8.dp)
                                .semantics { contentDescription = if (inUse) "${d.name}, in use" else d.name },
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(deviceIcon(d.kind), contentDescription = null, tint = content)
                            Text(d.name, style = MaterialTheme.typography.titleMedium, color = content, modifier = Modifier.weight(1f))
                            if (inUse) Icon(WaIcons.Check, contentDescription = null, tint = content)
                        }
                    }
                }
            }
        }
    }
}

private val DEVICE_IN_USE = androidx.compose.ui.graphics.Color(0xFF68E97A)
private val DEVICE_IN_USE_CONTENT = androidx.compose.ui.graphics.Color(0xFF0B1B32)

private fun deviceIcon(kind: DeviceKind?) = when (kind) {
    DeviceKind.Earpiece -> WaIcons.Earpiece
    DeviceKind.Bluetooth -> WaIcons.Bluetooth
    DeviceKind.Wired, DeviceKind.Usb -> WaIcons.Headset
    DeviceKind.Speaker, null -> WaIcons.Speaker
}
