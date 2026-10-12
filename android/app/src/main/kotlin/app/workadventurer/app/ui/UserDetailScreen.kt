package app.workadventurer.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.workadventurer.app.session.Activity
import app.workadventurer.app.session.Command
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.SessionState

/**
 * One person: their picture, name, status, where they are right now, and what you can do about it: invite them, or walk over
 * to them (to join their conversation if they are in one). Already together with them: just where they are.
 */
@Composable
fun UserDetailScreen(userId: Int, state: SessionState, onBack: () -> Unit, onCommand: (Command) -> Unit) {
    val player = state.players.firstOrNull { it.userId == userId }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp).semantics { contentDescription = "Back to the people list" }) {
                Icon(WaIcons.ArrowBack, contentDescription = null)
            }
        }
        if (player == null) {
            // They left (or went out of view) while this was open.
            Column(Modifier.weight(1f).fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text("This person is no longer here", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            }
            return@Column
        }

        val where = whereIs(userId, state)
        val name = playerLabel(player)
        val canMove = state.connection is Connection.Connected
        val walking = (state.activity as? Activity.WalkingTo)?.label == name

        Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            WokaAvatar(player.textures, player.name, 128.dp)
            Text(name, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 20.dp, bottom = 6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(Color(statusColor(player.availabilityStatus))))
                Text(statusLabel(player.availabilityStatus), style = MaterialTheme.typography.bodyLarge)
            }
            Row(
                Modifier.padding(top = 28.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surface).padding(16.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                    when (where) {
                        is Whereabouts.InBubble -> Text("🫧")
                        is Whereabouts.InArea -> Icon(WaIcons.MapPin, contentDescription = null, modifier = Modifier.size(22.dp))
                        Whereabouts.OnTheMap -> Icon(WaIcons.Map, contentDescription = null, modifier = Modifier.size(22.dp))
                    }
                }
                Column {
                    Text("Right now", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(whereText(where), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
            inviteStatusText(state.inviteStatus)?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp).semantics { liveRegion = LiveRegionMode.Polite })
            }
        }

        val explainer = walkExplainer(where)
        if (explainer == null) {
            // Together already: nothing to walk to or invite them to.
            Text(
                "You are already in this conversation with $name", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 20.dp),
            )
        } else {
            Column(Modifier.padding(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = { onCommand(Command.InvitePlayer(userId)) }, enabled = canMove,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 56.dp).semantics { contentDescription = "Invite $name to a meeting" },
                    shape = RoundedCornerShape(28.dp),
                ) {
                    Icon(WaIcons.UserPlus, contentDescription = null)
                    Spacer(Modifier.width(10.dp))
                    Text("Invite", style = MaterialTheme.typography.titleMedium)
                }
                PrimaryAction(
                    label = if (walking) "Walking over…" else "Walk over",
                    explainer = if (walking) "Your avatar is on its way to them" else explainer,
                    onClick = { onCommand(Command.WalkToPlayer(userId)) },
                    description = if (walking) "Walking over to $name" else "Walk over to $name and ${if (explainer.contains("join")) "join the conversation" else "start a conversation"}",
                    enabled = canMove && !walking,
                    quiet = walking,
                )
            }
        }
    }
}
