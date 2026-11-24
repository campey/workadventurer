package app.workadventurer.protocol.catalog

internal const val MAX_TEXT = 200

/**
 * Untrusted text bound for the UI: C0/C1/DEL controls and Unicode format, line and paragraph separators
 * (bidi overrides, zero-width characters, U+2028/9) become spaces; length capped with an ellipsis.
 */
fun sanitizeText(raw: String, max: Int = MAX_TEXT): String {
    val text = raw.map {
        val t = Character.getType(it)
        if (it.code <= 0x1f || it.code in 0x7f..0x9f ||
            t == Character.FORMAT.toInt() || t == Character.LINE_SEPARATOR.toInt() || t == Character.PARAGRAPH_SEPARATOR.toInt()
        ) ' ' else it
    }.joinToString("")
    if (text.length <= max) return text
    var end = max
    if (text[end - 1].isHighSurrogate()) end--
    return text.substring(0, end) + "…"
}
