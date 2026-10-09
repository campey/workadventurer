package app.workadventurer.app.ui

import app.workadventurer.protocol.Texture
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class WokaSpriteTest {
    // A woka sheet is 96x128: 3 columns by 4 rows of 32x32 frames (down, left, right, up; each row walks left-stand-right).
    // The picture the web shows is the facing-down standing frame: frame 1, the middle of the top row.
    @Test
    fun thePictureIsTheStandingFacingDownFrame() {
        assertEquals(WokaFrame(left = 32, top = 0, size = 32), WokaSprite.IDLE_DOWN)
        assertEquals(32, WokaSprite.FRAME)
    }

    // Layers draw bottom to top in the order the server sends them (body first, accessories last), so the key keeps the order.
    @Test
    fun theCacheKeyFollowsTheLayersInOrder() {
        val a = listOf(Texture("body", "https://x/b.png"), Texture("hair", "https://x/h.png"))
        assertEquals(WokaSprite.cacheKey(a), WokaSprite.cacheKey(a.toList()))
        assertNotEquals(WokaSprite.cacheKey(a), WokaSprite.cacheKey(a.reversed()))
        assertNotEquals(WokaSprite.cacheKey(a), WokaSprite.cacheKey(a.take(1)))
    }

    @Test
    fun aLayerWithNoIdIsKeyedByItsUrl() {
        assertNotEquals(
            WokaSprite.cacheKey(listOf(Texture("", "https://x/one.png"))),
            WokaSprite.cacheKey(listOf(Texture("", "https://x/two.png"))),
        )
    }

    @Test
    fun noLayersIsNoPicture() {
        assertEquals(true, WokaSprite.cacheKey(emptyList()).isEmpty())
    }

    // Until the picture loads (or if it can't), an initial on a colour that stays the same for the same name.
    @Test
    fun theInitialIsTheFirstLetterUppercased() {
        assertEquals("A", initialOf("ada"))
        assertEquals("A", initialOf("  ada"))
        assertEquals("Z", initialOf("Zoë"))
        assertEquals("🦊", initialOf("🦊 fox")) // a whole emoji, not half of one
        assertEquals("?", initialOf(""))
        assertEquals("?", initialOf("   "))
    }

    @Test
    fun theColourIsStablePerNameAndFromThePalette() {
        assertEquals(placeholderColor("Ada"), placeholderColor("Ada"))
        assertEquals(true, placeholderColor("Ada") in PLACEHOLDER_COLORS)
        assertEquals(true, placeholderColor("") in PLACEHOLDER_COLORS)
        // different names spread over the palette rather than all landing on one colour
        assertEquals(true, listOf("Ada", "Bo", "Cy", "Di", "Ed", "Flo", "Gus", "Hal").map { placeholderColor(it) }.toSet().size > 2)
    }
}
