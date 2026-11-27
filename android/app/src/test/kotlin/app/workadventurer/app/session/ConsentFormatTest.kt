package app.workadventurer.app.session

import app.workadventurer.protocol.catalog.AdapterAnswer
import app.workadventurer.protocol.catalog.AdapterOffer
import java.time.ZoneId
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ConsentFormatTest {
    private val utc = ZoneId.of("UTC")

    @Test fun releaseOnlyShownIfPlain() {
        assertEquals("v1.2.3", releaseDisplay("v1.2.3"))
        assertEquals("unknown", releaseDisplay("<b>hi</b> evil"))
        assertEquals("unknown", releaseDisplay(null))
    }

    @Test fun dateIsLocalDdMmmHhMm() {
        assertEquals("21 Nov 14:05", formatCatalogUpdated("2026-11-21T14:05:09Z", utc, Locale.ENGLISH))
        assertEquals("21 Nov 15:05", formatCatalogUpdated("2026-11-21T14:05:09Z", ZoneId.of("Europe/Paris"), Locale.ENGLISH))
        assertNull(formatCatalogUpdated("yesterday", utc, Locale.ENGLISH))
        assertNull(formatCatalogUpdated(null, utc, Locale.ENGLISH))
    }

    @Test fun shortUrlDropsSchemeAndEllipsisesTheMiddle() {
        assertEquals("host/a/b.json", shortUrl("https://host/a/b.json"))
        val s = shortUrl("https://raw.githubusercontent.com/campey/workadventurer/main/catalog/adapters/abcdef0123456789.json", 40)
        assertEquals(40, s.length)
        assertEquals(true, "…" in s)
    }

    @Test fun rowsShowVersionHashDateAndUrl() {
        val r = consentRows(AdapterOffer("deadbeef", "v1.2.3", "https://h/catalog/adapters/deadbeef.json", "2026-11-21T14:05:09Z"), utc, Locale.ENGLISH)
        assertEquals(listOf("Server version", "Server hash", "Catalog updated", "Adapter file"), r.map { it.label })
        assertEquals(listOf("v1.2.3", "deadbeef", "21 Nov 14:05", "https://h/catalog/adapters/deadbeef.json"), r.map { it.value })
        assertEquals(ConsentRowKind.MONO, r[1].kind)
        assertEquals(ConsentRowKind.MONO, r[3].kind)
    }

    @Test fun theAdaptersAddedDateReplacesTheCatalogUpdatedRow() {
        val r = consentRows(
            AdapterOffer("deadbeef", "v1.2.3", "https://h/a.json", catalogUpdated = "2026-11-26T20:46:13Z", adapterAdded = "2026-11-13T12:40:05Z"),
            utc, Locale.ENGLISH,
        )
        assertEquals(listOf("Server version", "Server hash", "Adapter added", "Adapter file"), r.map { it.label })
        assertEquals("13 Nov 12:40", r[2].value)
        assertEquals("Adapter added: 13 Nov 12:40", r[2].spoken)
    }

    @Test fun anUnparsableAddedFallsBackToTheCatalogDateThenUnknown() {
        val bad = consentRows(AdapterOffer("deadbeef", null, catalogUpdated = "2026-11-21T14:05:09Z", adapterAdded = "soon"), utc, Locale.ENGLISH)
        assertEquals("Catalog updated" to "21 Nov 14:05", bad[2].label to bad[2].value)
        val none = consentRows(AdapterOffer("deadbeef", null, adapterAdded = "soon"), utc, Locale.ENGLISH)
        assertEquals("Catalog updated" to "unknown", none[2].label to none[2].value)
    }

    @Test fun missingPartsAreUnknownAndNoUrlRowWithoutOne() {
        val r = consentRows(AdapterOffer("deadbeef", null), utc, Locale.ENGLISH)
        assertEquals(listOf("unknown", "deadbeef", "unknown"), r.map { it.value })
    }

    @Test fun checkboxDecidesBetweenAlwaysAndYes() {
        assertEquals(AdapterAnswer.ALWAYS, consentDownloadAnswer(true))
        assertEquals(AdapterAnswer.YES, consentDownloadAnswer(false))
    }

    @Test fun checkboxLabelIsExact() = assertEquals("Auto-download next time", CONSENT_AUTO_LABEL)
}
