package app.workadventurer.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The WorkAdventure web client's icons (Tabler glyphs: 24x24, stroke only, stroke width 1.5, round caps and joins), plus its
 * default world icon. Drawn in black and tinted where used. Path data is the web's, so the app and the web look alike.
 */
object WaIcons {
    private fun stroked(name: String, d: String, width: Float = 1.5f): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).addPath(
            pathData = PathParser().parsePathString(d).toNodes(),
            stroke = SolidColor(Color.Black),
            strokeLineWidth = width,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        ).build()

    val MicOn: ImageVector by lazy {
        stroked(
            "mic-on",
            "M9 2m0 3a3 3 0 0 1 3 -3h0a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3z M5 10a7 7 0 0 0 14 0 M8 21l8 0 M12 17l0 4",
        )
    }

    val MicOff: ImageVector by lazy {
        stroked(
            "mic-off",
            "M3 3l18 18 M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1 -.13 .874m-2 2a3 3 0 0 1 -3.87 -2.872v-1 " +
                "M5 10a7 7 0 0 0 10.846 5.85m2 -2a6.967 6.967 0 0 0 1.152 -3.85 M8 21l8 0 M12 17l0 4",
        )
    }

    val CameraOff: ImageVector by lazy {
        stroked(
            "camera-off",
            "M3 3l18 18 M15 11v-1l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -.675 .946 " +
                "M10 6h3a2 2 0 0 1 2 2v3m0 4v1a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2h1",
        )
    }

    val ChevronRight: ImageVector by lazy { stroked("chevron-right", "M9 6l6 6l-6 6", 2f) }

    val ArrowBack: ImageVector by lazy { stroked("arrow-back", "M15 6l-6 6l6 6", 2f) }

    val Walk: ImageVector by lazy {
        stroked("walk", "M13 4m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M7 21l3 -4 M16 21l-2 -4l-3 -3l1 -6 M6 12l2 -3l4 -1l3 3l3 1", 2f)
    }

    val UserPlus: ImageVector by lazy {
        stroked("user-plus", "M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0 M16 19h6 M19 16v6 M6 21v-2a4 4 0 0 1 4 -4h4", 2f)
    }

    val MapPin: ImageVector by lazy {
        stroked("map-pin", "M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0 M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z", 2f)
    }

    val Map: ImageVector by lazy { stroked("map", "M3 7l6 -3l6 3l6 -3v13l-6 3l-6 -3l-6 3v-13 M9 4v13 M15 7v13", 2f) }

    /** Material's three-dots overflow glyph: filled circles. */
    val MoreVert: ImageVector by lazy {
        ImageVector.Builder("more-vert", 24.dp, 24.dp, 24f, 24f).addPath(
            pathData = PathParser().parsePathString(
                "M12 8a2 2 0 1 0 0 -4a2 2 0 0 0 0 4z M12 14a2 2 0 1 0 0 -4a2 2 0 0 0 0 4z M12 20a2 2 0 1 0 0 -4a2 2 0 0 0 0 4z",
            ).toNodes(),
            fill = SolidColor(Color.Black),
        ).build()
    }

    /** The default world icon: the WorkAdventure coffee cup (512x512 source, see WorkAdventureLogoPaths.kt). */
    val WorldDefault: ImageVector by lazy {
        val b = ImageVector.Builder("world-default", 24.dp, 24.dp, 512f, 512f)
        for ((d, evenOdd) in WA_LOGO_PATHS) {
            b.addPath(
                pathData = PathParser().parsePathString(d).toNodes(),
                pathFillType = if (evenOdd) PathFillType.EvenOdd else PathFillType.NonZero,
                fill = SolidColor(Color.Black),
            )
        }
        b.build()
    }
}
