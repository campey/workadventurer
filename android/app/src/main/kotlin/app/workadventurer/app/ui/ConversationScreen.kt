package app.workadventurer.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import app.workadventurer.app.session.Command
import app.workadventurer.app.session.Connection
import app.workadventurer.app.session.SessionState

private val IN_COLOR = Color(0xFF68E97A)

/**
 * One bubble or area: who is in it, whether you are, and the one thing to do about it. Joining is walking your avatar
 * over (or into it) and leaving is walking out, so the action follows the walk: Join, Walking over…, then In the bubble
 * with Leave above it.
 */
@Composable
fun ConversationScreen(key: ConversationKey, state: SessionState, onBack: () -> Unit, onOpenPerson: (Int) -> Unit, onCommand: (Command) -> Unit) {
    val m = conversationScreen(key, state)
    val canMove = state.connection is Connection.Connected
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp).semantics { contentDescription = "Back to the people list" }) {
                Icon(WaIcons.ArrowBack, contentDescription = null)
            }
        }
        if (m == null) {
            Column(Modifier.weight(1f).fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text("This conversation is no longer here", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            }
            return@Column
        }

        Column(Modifier.padding(horizontal = 16.dp)) {
            Text(m.title, style = MaterialTheme.typography.headlineMedium)
            Text(
                m.strip, style = MaterialTheme.typography.bodyMedium,
                color = if (m.subtext != null) IN_COLOR else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp).clip(RoundedCornerShape(8.dp))
                    .background(MaterialTheme.colorScheme.surface).padding(horizontal = 10.dp, vertical = 6.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        Column(Modifier.weight(1f).fillMaxWidth().padding(top = 12.dp).verticalScroll(rememberScrollState())) {
            m.emptyText?.let {
                Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            }
            m.members.forEach { p -> PersonRow(p, onClick = if (p.isMe) null else ({ p.userId?.let(onOpenPerson) })) }
        }

        val join: Command? = when (key) {
            is ConversationKey.AreaKey -> Command.WalkToArea(key.key)
            is ConversationKey.Bubble -> m.members.firstOrNull { !it.isMe }?.userId?.let { Command.WalkToPlayer(it) }
        }
        Column(Modifier.padding(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when (m.phase) {
                Phase.CanJoin -> PrimaryAction(
                    m.joinLabel, m.explainer, onClick = { join?.let(onCommand) },
                    description = "${m.joinLabel}. ${m.explainer}", enabled = canMove && join != null,
                )
                Phase.Walking -> PrimaryAction(
                    "Walking over…", "Your avatar is on its way", onClick = {}, enabled = false, quiet = true,
                )
                Phase.Jitsi -> PrimaryAction(m.joinLabel, m.explainer, onClick = {}, enabled = false, quiet = true)
                Phase.Leaving -> PrimaryAction("Walking out…", "Your avatar is on its way out", onClick = {}, enabled = false, quiet = true)
                Phase.Joined -> {
                    PrimaryAction(
                        m.leaveLabel, m.leaveExplainer, onClick = { onCommand(Command.LeaveConversation) },
                        description = "${m.leaveLabel}. ${m.leaveExplainer}", enabled = canMove, danger = true,
                    )
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("✓ In the ${m.noun}", style = MaterialTheme.typography.titleMedium, color = IN_COLOR)
                        m.subtext?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
    }
}
