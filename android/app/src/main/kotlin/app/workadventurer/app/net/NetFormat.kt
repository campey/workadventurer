package app.workadventurer.app.net

import java.util.Locale
import kotlin.math.roundToInt

private val UNITS = listOf("B", "KB", "MB", "GB", "TB")

/** A byte total the way `ls -h` writes it: 1024s, one decimal below 10 (`1.5 KB`), none above (`123 MB`). */
fun formatBytes(bytes: Long): String {
    var v = bytes.coerceAtLeast(0).toDouble()
    var unit = 0
    while (v >= 1024 && unit < UNITS.lastIndex) { v /= 1024; unit++ }
    return if (unit == 0) "${v.toLong()} B" else "${compact(v)} ${UNITS[unit]}"
}

/** A rate from bytes per second, written as network rates are, in bits per second in 1000s (`24 kb/s`, `1.2 Mb/s`). */
fun formatRate(bytesPerSecond: Double): String {
    var v = (bytesPerSecond * 8).coerceAtLeast(0.0)
    val units = listOf("b/s", "kb/s", "Mb/s", "Gb/s")
    var unit = 0
    while (v >= 1000 && unit < units.lastIndex) { v /= 1000; unit++ }
    return if (unit == 0) "${v.roundToInt()} b/s" else "${compact(v)} ${units[unit]}"
}

/** A time from seconds (what WebRTC reports), in milliseconds; a dash when the link has not measured one. */
fun formatMs(seconds: Double?): String = if (seconds == null) "–" else "${(seconds * 1000).roundToInt()} ms"

/** A fraction (0.004 is 0.4%); a dash when unknown. */
fun formatPercent(fraction: Double?): String = when {
    fraction == null -> "–"
    fraction <= 0.0 -> "0%"
    else -> "${compact(fraction * 100)}%"
}

private fun compact(v: Double) = if (v < 10) String.format(Locale.ROOT, "%.1f", v) else String.format(Locale.ROOT, "%.0f", v)
