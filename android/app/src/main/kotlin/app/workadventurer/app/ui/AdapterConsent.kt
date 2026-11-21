package app.workadventurer.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import app.workadventurer.app.session.CONSENT_AUTO_HELP
import app.workadventurer.app.session.CONSENT_AUTO_LABEL
import app.workadventurer.app.session.CONSENT_SENTENCE
import app.workadventurer.app.session.CONSENT_TITLE
import app.workadventurer.app.session.ConsentRow
import app.workadventurer.app.session.ConsentRowKind
import app.workadventurer.app.session.GITHUB_LINK_LABEL
import app.workadventurer.app.session.consentDownloadAnswer
import app.workadventurer.app.session.consentRows
import app.workadventurer.protocol.catalog.AdapterAnswer
import app.workadventurer.protocol.catalog.AdapterOffer

/**
 * The question behind [app.workadventurer.app.session.Connection.NeedsConsent]. Download (once, or "Auto-download next time" when
 * ticked), Cancel. Back / outside tap / Cancel are a no and ignore the checkbox. State is the checkbox only (saved across rotation).
 */
@Composable
fun AdapterConsentDialog(offer: AdapterOffer, onAnswer: (AdapterAnswer) -> Unit) {
    var auto by rememberSaveable { mutableStateOf(false) }
    val rows = consentRows(offer)
    Dialog(onDismissRequest = { onAnswer(AdapterAnswer.NO) }) {
        Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
            Column(Modifier.fillMaxWidth().semantics { paneTitle = CONSENT_TITLE }.padding(24.dp)) {
                Text(CONSENT_TITLE, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    Text(
                        CONSENT_SENTENCE, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                    SectionLabel("DETAILS")
                    rows.forEach { ConsentRowView(it) }
                    offer.adapterUrl?.let { url ->
                        val uri = LocalUriHandler.current
                        TextButton(
                            onClick = { try { uri.openUri(url) } catch (e: Exception) { /* no browser: the URL is still selectable above */ } },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "View the adapter file on GitHub" },
                        ) { Text(GITHUB_LINK_LABEL) }
                    }
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(top = 8.dp)
                            .toggleable(value = auto, onValueChange = { auto = it }, role = Role.Checkbox)
                            .semantics(mergeDescendants = true) { contentDescription = "$CONSENT_AUTO_LABEL. $CONSENT_AUTO_HELP" },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = auto, onCheckedChange = null)
                        Column(Modifier.padding(start = 12.dp)) {
                            Text(CONSENT_AUTO_LABEL, style = MaterialTheme.typography.titleMedium)
                            Text(CONSENT_AUTO_HELP, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton(
                        onClick = { onAnswer(AdapterAnswer.NO) },
                        modifier = Modifier.weight(1f).heightIn(min = 56.dp).semantics { contentDescription = "Cancel, don't download" },
                        shape = RoundedCornerShape(32.dp),
                    ) { Text("Cancel", style = MaterialTheme.typography.titleMedium) }
                    Button(
                        onClick = { onAnswer(consentDownloadAnswer(auto)) },
                        modifier = Modifier.weight(1f).heightIn(min = 56.dp).semantics {
                            contentDescription = if (auto) "Download the update and auto-download next time" else "Download the update"
                        },
                        shape = RoundedCornerShape(32.dp),
                    ) { Text("Download", style = MaterialTheme.typography.titleMedium) }
                }
            }
        }
    }
}

@Composable
private fun ConsentRowView(row: ConsentRow) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).semantics(mergeDescendants = true) { contentDescription = row.spoken }) {
        Text(row.label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer {
            Text(
                row.value,
                style = MaterialTheme.typography.bodyLarge,
                fontFamily = if (row.kind == ConsentRowKind.MONO) FontFamily.Monospace else null,
                overflow = TextOverflow.Clip,
            )
        }
    }
}
