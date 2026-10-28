package app.workadventurer.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.TextUnitType
import androidx.compose.ui.unit.dp
import app.workadventurer.app.net.ConnectionRow
import app.workadventurer.app.net.NETWORK_SHEET_TITLE
import app.workadventurer.app.net.NetSnapshot
import app.workadventurer.app.net.detailLine
import app.workadventurer.app.net.rateLine
import app.workadventurer.app.net.rowDescription
import app.workadventurer.app.net.totalsLine

/**
 * The Network sheet (#171): each open connection with what it sends and receives (and, for call links, round trip, loss and
 * jitter), then what the app has used this session and all time. Opening it is what makes the numbers refresh every second.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NetworkSheet(net: NetSnapshot, onDismiss: () -> Unit, sheetState: SheetState, onReset: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 24.dp)
                .semantics { paneTitle = NETWORK_SHEET_TITLE },
        ) {
            SectionLabel("CONNECTIONS", first = true)
            Column(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(16.dp)).padding(vertical = 4.dp),
            ) { net.connections.forEach { ConnectionLine(it) } }

            SectionLabel("DATA USED")
            Column(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(16.dp)).padding(vertical = 4.dp),
            ) {
                TotalsLine("This session", totalsLine(net.session))
                TotalsLine("All time", totalsLine(net.allTime))
            }
            TextButton(onClick = onReset, modifier = Modifier.align(Alignment.End)) { Text("Reset all time") }
        }
    }
}

@Composable
private fun ConnectionLine(r: ConnectionRow) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 8.dp)
            .clearAndSetSemantics { contentDescription = rowDescription(r) },
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.size(10.dp).background(stateColor(r.state), CircleShape))
        Column(Modifier.weight(1f)) {
            Text(r.label, style = MaterialTheme.typography.titleMedium)
            Text(rateLine(r), style = MaterialTheme.typography.bodyMedium)
            detailLine(r)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Text(r.state, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun TotalsLine(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp)
            .clearAndSetSemantics { contentDescription = "$label: $value" },
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.titleMedium)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

/** Green when up, amber while coming up, grey when not connected (never a colour alone: the state is written beside it). */
private fun stateColor(state: String) = when (state) {
    "Connected" -> Color(0xFF68E97A)
    "Connecting", "New", "Checking" -> Color(0xFFFFB84D)
    else -> Color(0xFF8A94A6)
}

/** A small capitalised heading over a group in a sheet. */
@Composable
fun SectionLabel(text: String, first: Boolean = false) {
    Text(
        text, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold,
        letterSpacing = TextUnit(1.4f, TextUnitType.Sp),
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        modifier = Modifier.padding(start = 4.dp, top = if (first) 0.dp else 20.dp, bottom = 8.dp),
    )
}
