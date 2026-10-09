package app.workadventurer.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.workadventurer.app.session.Connection
import app.workadventurer.protocol.Wa133

/**
 * The front door: your name and the world's address, the world's details, and a blue Join at the bottom. Joining stays on this
 * screen (showing progress) until the room is really joined; then the app moves on to the Users screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JoinScreen(connection: Connection, initialName: String, onJoin: (name: String, room: String) -> Unit) {
    var name by rememberSaveable { mutableStateOf(initialName) }
    var room by rememberSaveable { mutableStateOf(Wa133.DEFAULT_ROOM) }
    var picking by remember { mutableStateOf(false) }
    val joining = connection is Connection.Connecting

    Column(Modifier.fillMaxSize()) {
        Column(
            // Scrolls, so a tall keyboard shortens the view instead of squashing the world tile.
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            OutlinedTextField(
                value = name, onValueChange = { name = it }, enabled = !joining, singleLine = true,
                label = { Text("Your name in the room") }, modifier = Modifier.fillMaxWidth(),
            )
            // The address stays editable for any world; the arrow offers the frequent ones.
            ExposedDropdownMenuBox(expanded = picking, onExpandedChange = { picking = it && !joining }) {
                OutlinedTextField(
                    value = room, onValueChange = { room = it }, enabled = !joining, singleLine = true,
                    label = { Text("World URL") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = picking) },
                    modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryEditable)
                        .semantics { contentDescription = "World URL. Choose a frequent world from the list." },
                )
                ExposedDropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                    ROOM_PRESETS.forEach { p ->
                        DropdownMenuItem(
                            text = { Text(p.name) },
                            onClick = { room = p.url; picking = false },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Choose ${p.name}" },
                        )
                    }
                }
            }
            WorldInfo(worldDetails(room))
            if (connection is Connection.Failed) {
                Text("Couldn't join: ${connection.message}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
        }
        PrimaryAction(
            label = if (joining) "Joining…" else "Join",
            explainer = if (name.isBlank()) "Enter your name to join" else "Enter this world as ${name.trim()}",
            onClick = { onJoin(name.trim(), room.trim()) },
            description = if (joining) "Joining the world" else "Join the world as ${name.trim()}",
            enabled = !joining && name.isNotBlank(),
        )
        Spacer(Modifier.padding(bottom = 12.dp))
    }
}
