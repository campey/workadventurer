package app.workadventurer.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.navArgument
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.workadventurer.app.session.Command
import app.workadventurer.app.session.SessionState
import app.workadventurer.protocol.Texture
import kotlinx.coroutines.launch

/**
 * The one screen host: a navigation graph under a scaffold whose bottom bar (mic, camera, more) is on every screen and whose top
 * bar (world, you) is on every screen inside a world. The screen shown follows the connection ([routeFor]): Join until the room
 * is joined, the Users screen while in it. The world panel slides in from the left, your sheet and the audio and video sheet
 * come up from the bottom; none of them is a screen, so Back closes them first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(
    state: SessionState,
    /** The mic choice remembered for the next join; the bar shows this before a room is joined. */
    micWanted: Boolean,
    notice: String?,
    initialName: String,
    wokaLoader: WokaLoader,
    /** Your woka layers as last seen for a world's server, for the Join preview (empty if never joined there). */
    texturesFor: (roomUrl: String) -> List<Texture>,
    onJoin: (name: String, room: String) -> Unit,
    onLeave: () -> Unit,
    onShareLogs: () -> Unit,
    onShareLink: (url: String) -> Unit,
    onMicChoice: (muted: Boolean) -> Unit,
    onCommand: (Command) -> Unit,
) {
    val nav = rememberNavController()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var showAvSheet by remember { mutableStateOf(false) }
    var showMeSheet by remember { mutableStateOf(false) }
    val avSheetState = rememberModalBottomSheetState()
    val meSheetState = rememberModalBottomSheetState()
    val drawer = rememberDrawerState(DrawerValue.Closed)

    // This Material version's drawer doesn't take Back itself: without this, Back with the panel open leaves the app.
    BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }

    val target = routeFor(state.connection)
    LaunchedEffect(target) {
        nav.navigate(target.path) { popUpTo(nav.graph.id) { inclusive = true } }
        drawer.close() // never leave the world panel open over the Join screen after leaving
    }
    LaunchedEffect(notice) { if (notice != null) snackbar.showSnackbar(notice) }

    // Walking into a Jitsi area: we don't support those yet (#119), so say so once, rather than leave someone in a call they can't hear.
    var areasBefore by remember { mutableStateOf(emptyList<app.workadventurer.protocol.Area>()) }
    LaunchedEffect(state.inAreas) {
        if (jitsiEntered(areasBefore, state.inAreas) != null) snackbar.showSnackbar(JITSI_NOT_SUPPORTED_MESSAGE)
        areasBefore = state.inAreas
    }

    // In a room the bar shows (and drives) the live mic; before joining it shows the remembered choice.
    val inRoom = target == Route.Users
    val muted = if (inRoom) state.muted else !micWanted
    val bar = avBarState(muted)
    val details = worldDetails(state.roomName)

    CompositionLocalProvider(LocalWokaLoader provides wokaLoader) {
        ModalNavigationDrawer(
            drawerState = drawer,
            gesturesEnabled = inRoom,
            drawerContent = {
                WorldPanel(
                    details = details,
                    onShareLink = { onShareLink(shareableRoomUrl(state.roomName)); scope.launch { drawer.close() } },
                    onShareLogs = onShareLogs,
                    onLeave = onLeave,
                )
            },
        ) {
            Scaffold(
                // Edge to edge doesn't resize for the keyboard by itself: lift everything (including Join) above it.
                modifier = Modifier.imePadding(),
                snackbarHost = { SnackbarHost(snackbar) },
                topBar = {
                    if (inRoom) {
                        RoomTopBar(
                            worldName = details.name, myName = state.myName, myTextures = state.myTextures,
                            onWorld = { scope.launch { drawer.open() } },
                            onMe = { showMeSheet = true },
                        )
                    }
                },
                bottomBar = {
                    AvBar(
                        state = bar,
                        onToggleMic = { onMicChoice(!muted) },
                        onCamera = { scope.launch { snackbar.showSnackbar(bar.cameraMessage) } },
                        onMore = { showAvSheet = true },
                    )
                },
            ) { padding ->
                NavHost(
                    nav, startDestination = target.path, modifier = Modifier.padding(padding),
                    // Between the top-level screens (Join, Users) just fade; going deeper slides in from the right (below).
                    enterTransition = { fadeIn() }, exitTransition = { fadeOut() },
                    popEnterTransition = { fadeIn() }, popExitTransition = { fadeOut() },
                ) {
                    composable(Route.Join.path) { JoinScreen(state.connection, initialName, texturesFor, onMessage = { scope.launch { snackbar.showSnackbar(it) } }, onJoin = onJoin) }
                    composable(
                        Route.Users.path,
                        // The list steps left a little when a screen slides in over it, and back when it leaves.
                        exitTransition = { if (targetState.destination.route == Route.User.PATTERN) slideOutHorizontally { -it / 4 } + fadeOut() else fadeOut() },
                        popEnterTransition = { if (initialState.destination.route == Route.User.PATTERN) slideInHorizontally { -it / 4 } + fadeIn() else fadeIn() },
                    ) { UsersScreen(state, onOpenPerson = { nav.navigate(Route.User(it).path) }, onMessage = { scope.launch { snackbar.showSnackbar(it) } }, onCommand = onCommand) }
                    composable(
                        Route.User.PATTERN,
                        arguments = listOf(navArgument("userId") { type = NavType.IntType }),
                        enterTransition = { slideInHorizontally { it } },
                        exitTransition = { fadeOut() },
                        popEnterTransition = { fadeIn() },
                        popExitTransition = { slideOutHorizontally { it } },
                    ) { entry ->
                        UserDetailScreen(entry.arguments?.getInt("userId") ?: -1, state, onBack = { nav.popBackStack() }, onCommand = onCommand)
                    }
                }
            }
        }

        if (showAvSheet) AvSheet(muted = muted, onDismiss = { showAvSheet = false }, sheetState = avSheetState)
        if (showMeSheet && inRoom) MeSheet(state.myName, state.myTextures, onDismiss = { showMeSheet = false }, sheetState = meSheetState)
    }
}
