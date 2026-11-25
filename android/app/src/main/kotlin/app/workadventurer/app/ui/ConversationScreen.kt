package app.workadventurer.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
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

private val OFFLINE_DOT = Color(0xFF8A99B3)

/**
 * One bubble or area: who is in it, whether you are, and the one thing to do about it. Joining is walking your avatar
 * over (or into it) and leaving is walking out, so the action follows the walk: Join, Walking over…, then In the bubble
 * with Leave above it.
 */
@Composable
fun ConversationScreen(key: ConversationKey, state: SessionState, onBack: () -> Unit, onOpenPerson: (Int) -> Unit, onCommand: (Command) -> Unit, onGone: () -> Unit = {}) {
    // Someone who just left stays in the list a moment, dimmed (the same as the people list).
    val (shown, left) = rememberWithLeavers(state)
    val live = conversationScreen(key, shown, left)
    // A bubble that dissolves under this screen (the server drops one of fewer than two) stays up for a moment, dimmed, then
    // we step back to the list. If you walked out of it yourself, or it never showed, we step back at once.
    var last by remember(key) { mutableStateOf<ConversationScreenModel?>(null) }
    if (live != null) last = live
    val m = live ?: last?.takeIf { key is ConversationKey.Bubble && holdsWhenDissolved(it) }?.let { dissolvedBubble(it) }
    LaunchedEffect(live == null) {
        if (live == null) { if (m != null) delay(LEAVER_HOLD_MS); onGone() }
    }
    val canMove = state.connection is Connection.Connected
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp).semantics { contentDescription = "Back to the people list" }) {
                Icon(WaIcons.ArrowBack, contentDescription = null)
            }
            m?.let { Text(it.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 4.dp)) }
        }
        if (m == null) {
            Column(Modifier.weight(1f).fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text(conversationGoneNotice(), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            }
            return@Column
        }

        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp))
                .background(MaterialTheme.colorScheme.surface).padding(horizontal = 16.dp, vertical = 12.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(if (m.subtext != null) DONE_COLOR else OFFLINE_DOT))
            Text(m.strip, style = MaterialTheme.typography.bodyMedium)
        }
        Column(Modifier.weight(1f).fillMaxWidth().padding(top = 12.dp).verticalScroll(rememberScrollState())) {
            m.emptyText?.let {
                Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            }
            // Someone who walked out of this bubble or area stays a moment too, dimmed.
            rememberWithWalkers(m.members, m.noun, key).forEach { p -> PersonRow(p, onClick = { p.userId?.let(onOpenPerson) }) }
        }

        val join: Command? = when (key) {
            is ConversationKey.AreaKey -> Command.WalkToArea(key.key)
            is ConversationKey.Bubble -> m.walkTargetId?.let { Command.WalkToPlayer(it) }
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
                Phase.Locked -> PrimaryAction(m.joinLabel, m.explainer, onClick = {}, enabled = false, quiet = true)
                Phase.Silent -> PrimaryAction(m.joinLabel, m.explainer, onClick = {}, enabled = false, quiet = true)
                Phase.Unavailable -> PrimaryAction(m.joinLabel, m.explainer, onClick = {}, enabled = false, quiet = true)
                Phase.Megaphone -> PrimaryAction(m.joinLabel, m.explainer, onClick = {}, enabled = false, quiet = true)
                Phase.Leaving -> PrimaryAction("Walking out…", "Your avatar is on its way out", onClick = {}, enabled = false, quiet = true)
                Phase.Joined -> {
                    PrimaryAction(
                        m.leaveLabel, "", onClick = { onCommand(Command.LeaveConversation) },
                        description = "${m.leaveLabel}. Walk your avatar out of the ${m.noun}", enabled = canMove, danger = true, icon = WaIcons.Leave, flipIcon = true,
                    )
                    PrimaryAction(
                        "In the ${m.noun}", m.subtext ?: "", onClick = {}, description = "You are in the ${m.noun}. ${m.subtext ?: ""}", done = true,
                    )
                }
            }
        }
    }
}
