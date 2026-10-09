package app.workadventurer.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.workadventurer.app.session.Connection
import app.workadventurer.protocol.Texture
import app.workadventurer.protocol.Wa133

/**
 * The front door: your name and the world's address, the world's details, and a blue Join at the bottom. Joining stays on this
 * screen (showing progress) until the room is really joined; then the app moves on to the Users screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JoinScreen(
    connection: Connection,
    initialName: String,
    texturesFor: (roomUrl: String) -> List<Texture>,
    onMessage: (String) -> Unit,
    onJoin: (name: String, room: String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf(initialName) }
    var room by rememberSaveable { mutableStateOf(Wa133.DEFAULT_ROOM) }
    var picking by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val urlFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val joining = connection is Connection.Connecting

    Column(Modifier.fillMaxSize()) {
        Column(
            // Scrolls, so a tall keyboard shortens the view instead of squashing the world tile.
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            // The address stays editable for any world; the arrow offers the frequent ones.
            ExposedDropdownMenuBox(expanded = picking, onExpandedChange = { picking = it && !joining }) {
                OutlinedTextField(
                    value = room, onValueChange = { room = it }, enabled = !joining, singleLine = true,
                    label = { Text("World / Room URL") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = picking) },
                    modifier = Modifier.fillMaxWidth().focusRequester(urlFocus).menuAnchor(MenuAnchorType.PrimaryEditable)
                        .semantics { contentDescription = "World or room URL. Choose a frequent world from the list." },
                )
                ExposedDropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                    ROOM_PRESETS.forEach { p ->
                        DropdownMenuItem(
                            text = { Text(p.name) },
                            // Close the keyboard too, so the world's details underneath are in view.
                            onClick = { room = p.url; picking = false; focus.clearFocus(); keyboard?.hide() },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Choose ${p.name}" },
                        )
                    }
                    // A world that isn't in the list: empty the address and put the cursor in it.
                    DropdownMenuItem(
                        text = { Text(NEW_WORLD_LABEL) },
                        onClick = { room = ""; picking = false; urlFocus.requestFocus(); keyboard?.show() },
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Enter a new world address" },
                    )
                }
            }
            WorldInfo(worldDetails(room))
            // Your name, and how you will look: the woka the server last gave you, as it appears in the top bar.
            // Bottom-aligned, and the same height as the name box (56 dp), so their tops and bottoms line up.
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it }, enabled = !joining, singleLine = true,
                    label = { Text("Your name in the room") }, modifier = Modifier.weight(1f),
                )
                val layers = remember(room) { texturesFor(room) }
                WokaAvatar(
                    layers, name.ifBlank { "?" }, 56.dp, offline = true, placeholder = WOKA_PREVIEW_PLACEHOLDER,
                    modifier = Modifier.clickable(role = Role.Button) { onMessage(WOKA_CUSTOMISATION_MESSAGE) }
                        .semantics { contentDescription = "Your woka, $OFFLINE_LABEL. Customising it is not built yet" },
                )
            }
            if (connection is Connection.Failed) {
                Text("Couldn't join: ${connection.message}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
        }
        PrimaryAction(
            label = if (joining) "Joining…" else "Join",
            explainer = joinExplainer(name, room),
            onClick = { onJoin(name.trim(), room.trim()) },
            description = if (joining) "Joining the world" else "Join the world as ${name.trim()}",
            enabled = canJoin(name, room, joining),
        )
        Spacer(Modifier.padding(bottom = 12.dp))
    }
}
