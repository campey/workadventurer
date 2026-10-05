package app.workadventurer.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.SessionState
import app.workadventurer.protocol.Wa133

/**
 * Minimal and TalkBack-first (the seed of the accessibility goal): every row is one focusable element
 * with a full description, nothing is conveyed by colour alone, touch targets are at least 48dp.
 */
@Composable
fun PresenceScreen(
    state: SessionState,
    onJoin: (name: String, room: String) -> Unit,
    onLeave: () -> Unit,
    notice: String? = null,
) {
    var name by rememberSaveable { mutableStateOf("") }
    var room by rememberSaveable { mutableStateOf(Wa133.DEFAULT_ROOM) }
    val inRoom = state.connection is Connection.Connecting ||
        state.connection is Connection.Connected ||
        state.connection is Connection.Reconnecting

    Column(
        Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedTextField(
            value = name, onValueChange = { name = it }, enabled = !inRoom,
            label = { Text("Your name in the room") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = room, onValueChange = { room = it }, enabled = !inRoom,
            label = { Text("Room URL") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = { if (inRoom) onLeave() else onJoin(name.trim(), room.trim()) },
            enabled = inRoom || name.isNotBlank(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text(if (inRoom) "Leave" else "Join") }

        Text(
            statusText(state.connection),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (notice != null) Text(notice, color = MaterialTheme.colorScheme.error)

        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            item {
                Text(
                    "Players (${state.players.size})",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.semantics { heading() },
                )
            }
            items(state.players, key = { it.userId }) { p ->
                val label = playerLabel(p)
                Text(
                    label,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .semantics(mergeDescendants = true) { contentDescription = "Player $label" },
                )
            }
            item {
                Text(
                    "Areas (${state.areas.size})",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.semantics { heading() },
                )
            }
            items(state.areas, key = { it.id ?: it.name }) { a ->
                val here = state.inAreas.any { (it.id ?: it.name) == (a.id ?: a.name) }
                val text = if (here) "${a.name} (you are here)" else a.name
                Text(
                    text,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .semantics(mergeDescendants = true) { contentDescription = "Area $text" },
                )
            }
        }
    }
}
