package app.workadventurer.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * The app's colours: the WorkAdventure web client's dark palette expressed as a Material 3 colour scheme. Always dark for now,
 * whatever the system setting says; a light scheme and a switch can be added here (one place) later.
 */
object WaColors {
    val Background = Color(0xFF0B1B32)
    val Surface = Color(0xFF1B2A41) // the web's "contrast"
    val SurfaceRaised = Color(0xFF223653)
    val SurfaceVariant = Color(0xFF2A4265)
    val Outline = Color(0xFF3C5E90)
    val OnSurface = Color(0xFFF9FAFB)
    val OnSurfaceMuted = Color(0xFFA9BDDB)
    val Primary = Color(0xFF4156F6)
    val Danger = Color(0xFFEA6E53)
    val DisabledIcon = Color(0xFF55627A)
}

private val WorkAdventurerColors = darkColorScheme(
    primary = WaColors.Primary,
    onPrimary = WaColors.OnSurface,
    secondary = WaColors.SurfaceVariant,
    onSecondary = WaColors.OnSurface,
    background = WaColors.Background,
    onBackground = WaColors.OnSurface,
    surface = WaColors.Surface,
    onSurface = WaColors.OnSurface,
    surfaceVariant = WaColors.SurfaceVariant,
    onSurfaceVariant = WaColors.OnSurfaceMuted,
    surfaceContainer = WaColors.Surface,
    surfaceContainerHigh = WaColors.SurfaceRaised,
    surfaceContainerHighest = WaColors.SurfaceRaised,
    outline = WaColors.Outline,
    outlineVariant = WaColors.Outline,
    error = WaColors.Danger,
    onError = WaColors.OnSurface,
)

@Composable
fun WorkAdventurerTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = WorkAdventurerColors, content = content)
}
