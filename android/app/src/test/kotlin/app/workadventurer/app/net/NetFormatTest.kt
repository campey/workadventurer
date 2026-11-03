package app.workadventurer.app.net

import kotlin.test.Test
import kotlin.test.assertEquals

class NetFormatTest {
    // Totals: bytes in 1024s, like `ls -h`.
    @Test
    fun byteTotalsAreHumanReadable() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("1023 B", formatBytes(1023))
        assertEquals("1.0 KB", formatBytes(1024))
        assertEquals("1.5 KB", formatBytes(1536))
        assertEquals("10 KB", formatBytes(10 * 1024))
        assertEquals("1.0 MB", formatBytes(1024L * 1024))
        assertEquals("123 MB", formatBytes(123L * 1024 * 1024))
        assertEquals("5.5 GB", formatBytes((5.5 * 1024 * 1024 * 1024).toLong()))
    }

    // Rates: bits per second in 1000s, as network rates are quoted; the input is bytes per second.
    @Test
    fun ratesAreBitsPerSecond() {
        assertEquals("0 b/s", formatRate(0.0))
        assertEquals("800 b/s", formatRate(100.0))
        assertEquals("24 kb/s", formatRate(3_050.0))
        assertEquals("1.2 Mb/s", formatRate(150_000.0))
        assertEquals("12 Mb/s", formatRate(1_500_000.0))
    }

    @Test
    fun roundTripJitterAndLoss() {
        assertEquals("38 ms", formatMs(0.038))
        assertEquals("0 ms", formatMs(0.0))
        assertEquals("–", formatMs(null))
        assertEquals("0%", formatPercent(0.0))
        assertEquals("0.4%", formatPercent(0.004))
        assertEquals("12%", formatPercent(0.12))
        assertEquals("–", formatPercent(null))
    }
}
