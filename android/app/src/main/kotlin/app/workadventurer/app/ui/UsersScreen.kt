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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.TextUnitType
import androidx.compose.ui.unit.dp
import app.workadventurer.app.session.Command
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.SessionState

/**
 * Who is where: the conversation you are in at the top, then other bubbles, meeting areas with people in them, "Is on this
 * map" (you first), then every other area. Every section stays open with its people. A section header with an arrow opens
 * that conversation; a person opens their screen. Until the conversation screen exists (next slice), a bubble or area header
 * walks you there, so nothing the old list could do is lost.
 */
@Composable
fun UsersScreen(state: SessionState, onOpenPerson: (userId: Int) -> Unit, onOpenConversation: (ConversationKey) -> Unit, onCommand: (Command) -> Unit) {
    val model = usersModel(state)
    val canMove = state.connection is Connection.Connected
    fun open(c: Conversation) = onOpenConversation(c.key)

    Column(Modifier.fillMaxSize()) {
        TransientRows(state, canMove, onCommand)
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            model.active?.let { c ->
                item(key = "active") {
                    Column(Modifier.background(MaterialTheme.colorScheme.surface.copy(alpha = 0.6f))) {
                        ConversationSection(c, you = true, onHeader = { open(c) }, onPerson = onOpenPerson)
                    }
                }
            }
            model.bubbles.forEach { c ->
                item(key = "b-${(c.key as ConversationKey.Bubble).groupId}") {
                    ConversationSection(c, you = false, onHeader = { open(c) }, onPerson = onOpenPerson)
                }
            }
            model.meetingAreas.forEach { c ->
                item(key = "a-${(c.key as ConversationKey.AreaKey).key}") {
                    ConversationSection(c, you = false, onHeader = { open(c) }, onPerson = onOpenPerson)
                }
            }
            item(key = "map") {
                Spacer(Modifier.height(8.dp))
                SectionHeader("Elsewhere on the map", onClick = null, description = "Elsewhere on the map")
                model.onMap.forEach { PersonRow(it, onClick = if (it.isMe) null else ({ it.userId?.let(onOpenPerson) })) }
                Spacer(Modifier.height(8.dp))
            }
            model.otherAreas.forEach { entry ->
                item(key = "o-${entry.area.id ?: entry.area.name}") {
                    SectionHeader(
                        entry.area.name,
                        onClick = { onOpenConversation(ConversationKey.AreaKey(entry.area.id ?: entry.area.name)) },
                        description = "Open ${entry.area.name}, ${if (entry.occupants.isEmpty()) "empty" else "${entry.occupants.size} here"}",
                    )
                    entry.occupants.forEach { PersonRow(it, onClick = if (it.isMe) null else ({ it.userId?.let(onOpenPerson) })) }
                }
            }
        }
    }
}

/** The things that appear and go: what the avatar is doing, the last invite you sent, and invitations waiting for an answer. */
@Composable
private fun TransientRows(state: SessionState, canMove: Boolean, onCommand: (Command) -> Unit) {
    val activity = activityText(state.activity)
    val inviteStatus = inviteStatusText(state.inviteStatus)
    val reconnecting = state.connection !is Connection.Connected
    if (activity == null && inviteStatus == null && state.pendingInvites.isEmpty() && !reconnecting) return
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (reconnecting) {
            Text(statusText(state.connection), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        activity?.let { text ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(text, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
                Button(
                    onClick = { onCommand(Command.StopMoving) },
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Stop. $text" },
                ) { Text("Stop") }
            }
        }
        inviteStatus?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        // Incoming invitations come first: they're time-sensitive and someone is waiting on the answer.
        state.pendingInvites.forEach { invite ->
            val text = inviteText(invite)
            val who = invite.senderName.ifBlank { "someone" }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(text, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
                Button(
                    onClick = { onCommand(Command.AcceptInvite(invite.senderUuid)) }, enabled = canMove,
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Accept invitation from $who" },
                ) { Text("Accept") }
                TextButton(
                    onClick = { onCommand(Command.DeclineInvite(invite.senderUuid)) }, enabled = canMove,
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Decline invitation from $who" },
                ) { Text("Decline") }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
    }
}

@Composable
private fun ConversationSection(c: Conversation, you: Boolean, onHeader: () -> Unit, onPerson: (Int) -> Unit) {
    val title = if (you) "${c.title} · you are here" else c.title
    SectionHeader(
        title, onClick = onHeader,
        description = "${if (you) "You are in " else "Open "}${c.title}, ${c.members.size} people",
    )
    c.members.forEach { PersonRow(it, onClick = if (it.isMe) null else ({ it.userId?.let(onPerson) })) }
}

/** A section's title; the web's uppercase, spaced style. An arrow means it can be opened. */
@Composable
private fun SectionHeader(title: String, onClick: (() -> Unit)?, description: String) {
    Column {
        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
                .padding(horizontal = 16.dp)
                .semantics(mergeDescendants = true) { contentDescription = description; if (onClick == null) heading() },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                title.uppercase(), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold,
                letterSpacing = TextUnit(1.4f, TextUnitType.Sp),
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.78f),
            )
            if (onClick != null) Icon(WaIcons.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** One person: their picture with status dot, name (with "(You)" for you) and status line. Tap opens their screen. */
@Composable
internal fun PersonRow(p: Participant, onClick: (() -> Unit)?) {
    val label = if (p.isMe) "${p.name} (You)" else p.name
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = "$label, ${statusLabel(p.status)}${if (onClick != null) ". Opens their screen" else ""}"
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        WokaAvatar(p.textures, p.name, 40.dp, status = p.status)
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(Color(statusColor(p.status))))
                Text(statusLabel(p.status), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
