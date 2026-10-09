package app.workadventurer.app.ui

import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.workadventurer.app.session.Command
import app.workadventurer.app.session.SessionState
import kotlinx.coroutines.launch

/**
 * The one screen host: a navigation graph under a scaffold whose bottom bar (mic, camera, more) is on every screen. The screen
 * shown follows the connection ([routeFor]): Join until the room is joined, the Users screen while in it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(
    state: SessionState,
    /** The mic choice remembered for the next join; the bar shows this before a room is joined. */
    micWanted: Boolean,
    notice: String?,
    initialName: String,
    onJoin: (name: String, room: String) -> Unit,
    onLeave: () -> Unit,
    onShareLogs: () -> Unit,
    onMicChoice: (muted: Boolean) -> Unit,
    onCommand: (Command) -> Unit,
) {
    val nav = rememberNavController()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var showAvSheet by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState()

    val target = routeFor(state.connection)
    LaunchedEffect(target) {
        nav.navigate(target.path) { popUpTo(nav.graph.id) { inclusive = true } }
    }
    LaunchedEffect(notice) { if (notice != null) snackbar.showSnackbar(notice) }

    // In a room the bar shows (and drives) the live mic; before joining it shows the remembered choice.
    val inRoom = target == Route.Users
    val muted = if (inRoom) state.muted else !micWanted
    val bar = avBarState(muted)

    Scaffold(
        // Edge to edge doesn't resize for the keyboard by itself: lift everything (including Join) above it.
        modifier = Modifier.imePadding(),
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            AvBar(
                state = bar,
                onToggleMic = { onMicChoice(!muted) },
                onCamera = { scope.launch { snackbar.showSnackbar(bar.cameraMessage) } },
                onMore = { showAvSheet = true },
            )
        },
    ) { padding ->
        NavHost(nav, startDestination = target.path, modifier = Modifier.padding(padding)) {
            composable(Route.Join.path) { JoinScreen(state.connection, initialName, onJoin) }
            composable(Route.Users.path) { UsersScreen(state, onLeave, onShareLogs, onCommand) }
        }
    }

    if (showAvSheet) AvSheet(muted = muted, onDismiss = { showAvSheet = false }, sheetState = sheetState)
}
