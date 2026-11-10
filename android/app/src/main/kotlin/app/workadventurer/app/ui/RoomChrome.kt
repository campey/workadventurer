package app.workadventurer.app.ui
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue


import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.workadventurer.proto.AvailabilityStatus
import app.workadventurer.protocol.Texture

/** What we announce ourselves as: the app has no way to change it yet, so we are always online. */
val MY_STATUS = AvailabilityStatus.ONLINE

/**
 * The bar across the top of every screen once you are in a world: the world's icon and name, and your own woka picture with
 * your status dot on the right. The whole bar is one button that opens the world panel (the world, and you).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomTopBar(worldName: String, myName: String, myTextures: List<Texture>, onOpen: () -> Unit) {
    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = MaterialTheme.colorScheme.onSurface,
        ),
        modifier = Modifier.clickable(role = Role.Button, onClick = onOpen)
            .semantics(mergeDescendants = true) { contentDescription = "Open the world panel for $worldName. You are $myName, ${statusLabel(MY_STATUS)}" },
        navigationIcon = {
            Box(
                Modifier.padding(start = 16.dp).size(36.dp).border(2.dp, MaterialTheme.colorScheme.onSurface, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) { Icon(WaIcons.WorldDefault, contentDescription = null, modifier = Modifier.size(20.dp)) }
        },
        title = { Text(worldName, maxLines = 1, modifier = Modifier.padding(start = 4.dp)) },
        actions = {
            Box(Modifier.padding(end = 12.dp).size(48.dp), contentAlignment = Alignment.Center) {
                WokaAvatar(myTextures, myName, 36.dp, status = MY_STATUS)
            }
        },
    )
}

private val ShareIcon: ImageVector by lazy {
    ImageVector.Builder("share", 24.dp, 24.dp, 24f, 24f).addPath(
        pathData = PathParser().parsePathString(
            "M6 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M18 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 " +
                "M7.7 11l8.6 -4 M7.7 13l8.6 4",
        ).toNodes(),
        stroke = androidx.compose.ui.graphics.SolidColor(Color.Black), strokeLineWidth = 2f,
        strokeLineCap = androidx.compose.ui.graphics.StrokeCap.Round, strokeLineJoin = androidx.compose.ui.graphics.StrokeJoin.Round,
    ).build()
}

private val BugIcon: ImageVector by lazy {
    ImageVector.Builder("bug", 24.dp, 24.dp, 24f, 24f).addPath(
        pathData = PathParser().parsePathString(
            "M9 9v-1a3 3 0 0 1 6 0v1 M8 9h8a6 6 0 0 1 1 3v3a5 5 0 0 1 -10 0v-3a6 6 0 0 1 1 -3 M3 13l4 0 M17 13l4 0 M12 20l0 -6 " +
                "M4 19l3.35 -2 M20 19l-3.35 -2 M4 7l3.75 2.4 M20 7l-3.75 2.4",
        ).toNodes(),
        stroke = androidx.compose.ui.graphics.SolidColor(Color.Black), strokeLineWidth = 2f,
        strokeLineCap = androidx.compose.ui.graphics.StrokeCap.Round, strokeLineJoin = androidx.compose.ui.graphics.StrokeJoin.Round,
    ).build()
}

private val LeaveIcon: ImageVector by lazy {
    ImageVector.Builder("leave", 24.dp, 24.dp, 24f, 24f).addPath(
        pathData = PathParser().parsePathString(
            "M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2 M9 12h12l-3 -3 M18 15l3 -3",
        ).toNodes(),
        stroke = androidx.compose.ui.graphics.SolidColor(Color.Black), strokeLineWidth = 2f,
        strokeLineCap = androidx.compose.ui.graphics.StrokeCap.Round, strokeLineJoin = androidx.compose.ui.graphics.StrokeJoin.Round,
    ).build()
}

/**
 * The panel that slides in from the left: the world's details, a link to share, and at the bottom Leave beside a button that
 * shares the debug logs. Only what exists today is here; world options are added as they come.
 */
@Composable
fun WorldPanel(
    details: WorldDetails, onShareLink: () -> Unit, onShareLogs: () -> Unit, onLeave: () -> Unit,
    /** You, as the room sees you: change the name (or, soon, the woka) and rejoin to apply it. */
    myName: String = "", myTextures: List<Texture> = emptyList(), connected: Boolean = true,
    /** The woka you picked but are not wearing yet: shown in place of [myTextures], and it makes Rejoin live. */
    pendingWoka: Texture? = null,
    onWoka: () -> Unit = {}, onRejoin: (name: String) -> Unit = {},
) {
    ModalDrawerSheet(
        drawerContainerColor = MaterialTheme.colorScheme.surface,
        drawerShape = RoundedCornerShape(topEnd = 28.dp, bottomEnd = 28.dp),
    ) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp).padding(top = 28.dp)) {
            WorldInfo(details, plain = true)
            TextButton(
                onClick = onShareLink,
                modifier = Modifier.padding(top = 8.dp).heightIn(min = 56.dp).semantics { contentDescription = "Share a link to this room" },
            ) {
                Icon(ShareIcon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(14.dp))
                Text("Share link to room", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            }
            // You, like on the Join screen. The name and woka are fixed for a connection, so changing them needs a rejoin.
            HorizontalDivider(Modifier.padding(top = 12.dp, bottom = 16.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
            var typed by rememberSaveable(myName) { mutableStateOf(myName) }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = typed, onValueChange = { typed = it }, singleLine = true,
                    label = { Text("Your name in the room") }, modifier = Modifier.weight(1f),
                )
                WokaTile(
                    pendingWoka?.let { listOf(it) } ?: myTextures, typed, onClick = onWoka,
                    description = wokaTileDescription(offline = false), offline = false,
                )
            }
            Spacer(Modifier.height(16.dp))
            PrimaryAction(
                label = rejoinLabel(typed), explainer = REJOIN_EXPLAINER, onClick = { onRejoin(typed.trim()) },
                description = "${rejoinLabel(typed)}. $REJOIN_EXPLAINER",
                enabled = canRejoin(current = myName, typed = typed, wokaChanged = pendingWoka != null, connected = connected), quiet = true,
            )
            Spacer(Modifier.height(16.dp))
        }
        HorizontalDivider(Modifier.padding(horizontal = 28.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 28.dp, vertical = 16.dp).navigationBarsPadding(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = onLeave,
                modifier = Modifier.weight(1f).heightIn(min = 56.dp).semantics { contentDescription = "Leave the room ${details.name}" },
                shape = RoundedCornerShape(28.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant, contentColor = MaterialTheme.colorScheme.onSurface),
            ) {
                Icon(LeaveIcon, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                Spacer(Modifier.width(12.dp))
                Text("Leave the room", style = MaterialTheme.typography.titleMedium)
            }
            IconButton(
                onClick = onShareLogs,
                modifier = Modifier.size(56.dp).semantics { contentDescription = "Share debug logs" },
            ) { Icon(BugIcon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}
