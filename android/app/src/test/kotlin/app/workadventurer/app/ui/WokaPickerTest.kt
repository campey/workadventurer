package app.workadventurer.app.ui

import app.workadventurer.protocol.Texture
import app.workadventurer.protocol.WaStaging
import app.workadventurer.protocol.Wa133
import app.workadventurer.protocol.WokaCatalogue
import app.workadventurer.protocol.WokaCollection
import app.workadventurer.protocol.WokaTexture
import kotlin.test.Test
import kotlin.test.assertEquals

class WokaPickerTest {
    private fun tex(id: String, name: String) = WokaTexture(id, name, "https://x/$id.png")

    private val catalogue = WokaCatalogue(
        mapOf(
            "woka" to listOf(
                WokaCollection("Default Collection", listOf(tex("1", "Bob"), tex("2", "Steve"))),
                WokaCollection("Empty one", emptyList()),
                WokaCollection("Legacy Collection", listOf(tex("3", "Old"))),
            ),
            "hair" to listOf(WokaCollection("Default Collection", listOf(tex("h", "Bald")))),
        ),
    )

    // Whole characters only for now (the other parts are layers to compose from, a later slice), and a collection with nothing in
    // it is not a heading over nothing.
    @Test
    fun sectionsAreTheWokaCollectionsThatHaveWokas() {
        val s = wokaSections(catalogue)
        assertEquals(listOf("Default Collection", "Legacy Collection"), s.map { it.title })
        assertEquals(listOf("Bob", "Steve"), s[0].wokas.map { it.name })
    }

    @Test
    fun aCatalogueWithoutWokasHasNoSections() {
        assertEquals(emptyList(), wokaSections(WokaCatalogue(emptyMap())))
    }

    // Selected is what you chose, else the server's default (what a join sends when nothing is chosen).
    @Test
    fun theSelectedWokaIsYourChoiceElseTheServersDefault() {
        val prod = "https://play.workadventu.re/@/a/b/c"
        val staging = "https://play.staging.workadventu.re/@/a/b/c"
        assertEquals("mine", selectedWokaId(Texture("mine", "https://x/m.png"), prod))
        assertEquals(Wa133.DEFAULT_WOKA, selectedWokaId(null, prod))
        assertEquals(WaStaging.DEFAULT_WOKA, selectedWokaId(null, staging))
    }

    @Test
    fun aCellIsNamedAndSaysWhetherItIsSelected() {
        assertEquals("Bob", wokaCellDescription("Bob", selected = false))
        assertEquals("Bob, selected", wokaCellDescription("Bob", selected = true))
        assertEquals("Unnamed woka", wokaCellDescription("", selected = false))
    }

    @Test
    fun whatTheCatalogueOffersIsShownWhereverItIsTheDefaultOrNot() {
        // The cell's picture is the woka's own texture, so the picker shows the real thing.
        assertEquals(Texture("1", "https://x/1.png"), wokaTexture(tex("1", "Bob")))
    }
}
