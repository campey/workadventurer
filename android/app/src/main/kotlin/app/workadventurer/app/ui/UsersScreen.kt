package app.workadventurer.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.workadventurer.app.session.Command
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.SessionState

/**
 * The room. For now this is the people-and-areas list the app already had, minus the join form and the mic (which moved to the
 * Join screen and the bottom bar); the sections in the design replace it in the Users slice, and Leave and Share logs move into
 * the world panel with the top bar. Every row is one focusable element with a full description, buttons are at least 48dp, and
 * what changes is a live region, so TalkBack is complete.
 */
@Composable
fun UsersScreen(
    state: SessionState,
    onLeave: () -> Unit,
    onShareLogs: () -> Unit,
    onCommand: (Command) -> Unit,
) {
    val canMove = state.connection is Connection.Connected
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            statusText(state.connection),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = onLeave,
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Leave the room" },
            ) { Text("Leave") }
            TextButton(
                onClick = onShareLogs,
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Share the logs of recent calls" },
            ) { Text("Share logs") }
        }
        activityText(state.activity)?.let { text ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(text, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
                Button(
                    onClick = { onCommand(Command.StopMoving) },
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Stop. $text" },
                ) { Text("Stop") }
            }
        }
        inviteStatusText(state.inviteStatus)?.let { text ->
            Text(text, Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        // Incoming invitations come first: they're time-sensitive and someone is waiting on the answer.
        state.pendingInvites.forEach { invite ->
            val text = inviteText(invite)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(text, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
                Button(
                    onClick = { onCommand(Command.AcceptInvite(invite.senderUuid)) }, enabled = canMove,
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Accept invitation from ${invite.senderName.ifBlank { "someone" }}" },
                ) { Text("Accept") }
                TextButton(
                    onClick = { onCommand(Command.DeclineInvite(invite.senderUuid)) }, enabled = canMove,
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Decline invitation from ${invite.senderName.ifBlank { "someone" }}" },
                ) { Text("Decline") }
            }
        }

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
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(label, Modifier.weight(1f).semantics { contentDescription = "Player $label" })
                    TextButton(
                        onClick = { onCommand(Command.WalkToPlayer(p.userId)) }, enabled = canMove,
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Walk to $label" },
                    ) { Text("Walk to") }
                    TextButton(
                        onClick = { onCommand(Command.InvitePlayer(p.userId)) }, enabled = canMove,
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Invite $label to talk" },
                    ) { Text("Invite") }
                }
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
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(text, Modifier.weight(1f).semantics { contentDescription = "Area $text" })
                    TextButton(
                        onClick = { onCommand(Command.WalkToArea(a.id ?: a.name)) }, enabled = canMove,
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Walk to ${a.name}" },
                    ) { Text("Walk to") }
                }
            }
        }
    }
}
