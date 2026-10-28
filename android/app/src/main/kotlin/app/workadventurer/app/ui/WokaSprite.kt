package app.workadventurer.app.ui

import app.workadventurer.protocol.Texture

/** One 32x32 frame of a woka sprite sheet: [left] and [top] in pixels from the sheet's top-left corner. */
data class WokaFrame(val left: Int, val top: Int, val size: Int)

/**
 * The woka (avatar) pictures. A woka is a stack of layers (body, eyes, hair, clothes, hat, accessories; or one full-body sheet),
 * each a public 96x128 PNG sprite sheet of 3 columns by 4 rows of 32x32 frames (down, left, right, up; each row is
 * left-foot, standing, right-foot). The picture the web client shows is every layer's standing, facing-down frame stacked in
 * the order the server sends them, scaled up without smoothing. The drawing is in WokaLoader; this is the part that can be tested.
 */
object WokaSprite {
    const val FRAME = 32
    val IDLE_DOWN = WokaFrame(left = FRAME, top = 0, size = FRAME)

    /** One key for a whole woka (its layers, in order), so a finished picture is built once and reused. */
    fun cacheKey(textures: List<Texture>): String = textures.joinToString("|") { it.id.ifBlank { it.url } }
}

/** The first letter (a whole emoji counts as one) shown while a picture loads or when it can't. */
fun initialOf(name: String): String {
    val t = name.trim()
    if (t.isEmpty()) return "?"
    return String(Character.toChars(t.codePointAt(0))).uppercase()
}

/** Soft, equally light colours so dark text is readable on every one of them (the design's placeholder tiles). */
val PLACEHOLDER_COLORS: List<Long> = listOf(
    0xFF9FD6A6, 0xFFF0B8A0, 0xFFA9BDDB, 0xFFC9B6F2, 0xFF8FD3E0, 0xFFE9D58E, 0xFFEFA9C4, 0xFFB7D68F,
)

/** The same name always gets the same colour. */
fun placeholderColor(name: String): Long =
    PLACEHOLDER_COLORS[Math.floorMod(name.trim().lowercase().hashCode(), PLACEHOLDER_COLORS.size)]
