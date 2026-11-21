package app.workadventurer.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.workadventurer.protocol.catalog.AdapterUpdates

const val SETTINGS_SHEET_TITLE = "Settings"

fun adapterUpdatesLabel(m: AdapterUpdates): String = when (m) {
    AdapterUpdates.ASK -> "Ask me"
    AdapterUpdates.AUTO -> "Download automatically"
    AdapterUpdates.NEVER -> "Never download"
}

fun adapterUpdatesHelp(m: AdapterUpdates): String = when (m) {
    AdapterUpdates.ASK -> "When a server is newer than this app, ask before downloading its adapter."
    AdapterUpdates.AUTO -> "When a server is newer than this app, download its adapter without asking."
    AdapterUpdates.NEVER -> "Never download adapters. Newer servers won't work until the app is updated."
}

/** Settings, in the style of the Network sheet: one group of radio choices for the adapter-updates preference. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(current: AdapterUpdates, onPick: (AdapterUpdates) -> Unit, onDismiss: () -> Unit, sheetState: SheetState) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 20.dp, end = 20.dp, bottom = 24.dp)
                .semantics { paneTitle = SETTINGS_SHEET_TITLE },
        ) {
            SectionLabel("ADAPTER UPDATES", first = true)
            Column(Modifier.selectableGroup()) {
                AdapterUpdates.entries.forEach { m ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp)
                            .selectable(selected = m == current, onClick = { onPick(m) }, role = Role.RadioButton),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = m == current, onClick = null)
                        Text(adapterUpdatesLabel(m), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 16.dp))
                    }
                }
            }
            Text(adapterUpdatesHelp(current), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
