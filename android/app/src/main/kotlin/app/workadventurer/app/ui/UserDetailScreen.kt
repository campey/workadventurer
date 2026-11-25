package app.workadventurer.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
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
fun UserDetailScreen(userId: Int, state: SessionState, onBack: () -> Unit, onOpenConversation: (ConversationKey) -> Unit, onCommand: (Command) -> Unit) {
    // You are not in the players list: your own picture, name and place come from the session.
    val isMe = state.myUserId != null && userId == state.myUserId
    val player = state.players.firstOrNull { it.userId == userId }
    // Remember who they were, so if they leave while this is open the screen can still say who it was.
    var lastSeen by remember(userId) { mutableStateOf<app.workadventurer.protocol.Player?>(null) }
    if (player != null) lastSeen = player
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp).semantics { contentDescription = "Back to the people list" }) {
                Icon(WaIcons.ArrowBack, contentDescription = null)
            }
        }
        if (!isMe && player == null) {
            // They left (or went out of view) while this was open.
            Column(Modifier.weight(1f).fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                lastSeen?.let { WokaAvatar(it.textures, playerLabel(it), 96.dp) }
                Text(
                    personGoneNotice(lastSeen?.let { playerLabel(it) }), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 16.dp),
                )
            }
            return@Column
        }

        val where = if (isMe) whereAmI(state) else whereIs(userId, state)
        val name = if (isMe) state.myName.ifBlank { "You" } else playerLabel(player!!)
        val textures = if (isMe) state.myTextures else player!!.textures
        val status = if (isMe) state.myStatus else player!!.availabilityStatus
        val canMove = state.connection is Connection.Connected
        val walking = !isMe && (state.activity as? Activity.WalkingTo)?.label == name

        Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            WokaAvatar(textures, name, 128.dp)
            Text(if (isMe) "$name (You)" else name, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 20.dp, bottom = 6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(Color(statusColor(status))))
                Text(statusLabel(status), style = MaterialTheme.typography.bodyLarge)
            }
            // Your own screen is where you choose your status (#111).
            if (isMe) StatusPicker(state.myStatus, onPick = { onCommand(Command.SetStatus(it)) })
            val conversation = where.conversation()
            Row(
                Modifier.padding(top = 28.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surface)
                    .then(if (conversation != null) Modifier.clickable(role = Role.Button, onClick = { onOpenConversation(conversation) }) else Modifier)
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                    when (where) {
                        is Whereabouts.InBubble -> Text("🫧")
                        is Whereabouts.InArea -> Icon(WaIcons.MapPin, contentDescription = null, modifier = Modifier.size(22.dp))
                        Whereabouts.OnTheMap -> Icon(WaIcons.Map, contentDescription = null, modifier = Modifier.size(22.dp))
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text("Right now", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(if (isMe) whereTextForMe(where) else whereText(where), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
                if (conversation != null) Icon(WaIcons.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            inviteStatusText(state.inviteStatus)?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp).semantics { liveRegion = LiveRegionMode.Polite })
            }
        }

        val explainer = if (isMe) null else walkExplainer(where)
        if (explainer == null) {
            // Together already (or it is you): nothing to walk to or invite them to; the one action opens the conversation.
            val conversation = where.conversation()
            if (conversation != null) PrimaryAction(
                label = "Open the conversation", explainer = if (isMe) "" else togetherNote(where) ?: "", onClick = { onOpenConversation(conversation) },
                description = if (isMe) "Open the conversation you are in" else "Open the conversation you are in with $name", quiet = true,
            )
        } else {
            // What stops each action: a locked bubble, a silent area, or a status that keeps them out of every conversation (#111).
            val blocks = actionBlocks(where, status, mine = state.myStatus)
            Column(Modifier.padding(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = { onCommand(Command.InvitePlayer(userId)) }, enabled = canMove && blocks.invite == null,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 56.dp).semantics { contentDescription = "Invite $name to a meeting" },
                    shape = RoundedCornerShape(28.dp),
                ) {
                    Icon(WaIcons.UserPlus, contentDescription = null)
                    Spacer(Modifier.width(10.dp))
                    Text("Invite", style = MaterialTheme.typography.titleMedium)
                }
                // Say why, rather than let you walk over and stand next to them. When only Invite is stopped its reason goes under it.
                val blocked = blocks.walk
                if (blocks.invite != null && blocked == null) Text(
                    blocks.invite, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                )
                PrimaryAction(
                    label = if (walking) "Walking over…" else "Walk over",
                    explainer = if (walking) "Your avatar is on its way to them" else blocked ?: explainer,
                    onClick = { onCommand(Command.WalkToPlayer(userId)) },
                    description = if (walking) "Walking over to $name" else "Walk over to $name and ${if (explainer.contains("join")) "join the conversation" else "start a conversation"}",
                    enabled = canMove && !walking && blocked == null,
                    quiet = walking || blocked != null,
                )
            }
        }
    }
}

/** "Your status": the four the web client offers, each with what it means. Choosing one is sent at once, and kept for the next join. */
@Composable
private fun StatusPicker(current: app.workadventurer.proto.AvailabilityStatus, onPick: (app.workadventurer.proto.AvailabilityStatus) -> Unit) {
    Column(Modifier.padding(top = 20.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surface).padding(vertical = 8.dp)) {
        Text(
            "Your status", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
        for (choice in SELECTABLE_STATUSES) {
            val selected = choice.status == current
            Row(
                Modifier.fillMaxWidth().heightIn(min = 56.dp)
                    .selectable(selected = selected, role = Role.RadioButton, onClick = { onPick(choice.status) })
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .semantics { contentDescription = "${statusLabel(choice.status)}. ${choice.hint}${if (selected) ". Selected" else ""}" },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Box(Modifier.size(12.dp).clip(CircleShape).background(Color(statusColor(choice.status))))
                Column(Modifier.weight(1f)) {
                    Text(statusLabel(choice.status), style = MaterialTheme.typography.bodyLarge)
                    Text(choice.hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (selected) Icon(WaIcons.Check, contentDescription = null)
            }
        }
    }
}
