package app.workadventurer.protocol.catalog

internal const val MAX_TEXT = 200

/**
 * Untrusted text bound for the UI: C0/C1/DEL controls and Unicode format, line and paragraph separators
 * (bidi overrides, zero-width characters, U+2028/9) become spaces; length capped with an ellipsis.
 */
fun sanitizeText(raw: String, max: Int = MAX_TEXT): String {
    // By code point, so a non-BMP format character (e.g. U+E0001, U+1D173) becomes one space, not two stray surrogates.
    val sb = StringBuilder(raw.length)
    var i = 0
    while (i < raw.length) {
        val cp = raw.codePointAt(i)
        val t = Character.getType(cp)
        if (cp <= 0x1f || cp in 0x7f..0x9f ||
            t == Character.FORMAT.toInt() || t == Character.LINE_SEPARATOR.toInt() || t == Character.PARAGRAPH_SEPARATOR.toInt()
        ) sb.append(' ') else sb.appendCodePoint(cp)
        i += Character.charCount(cp)
    }
    val text = sb.toString()
    if (text.length <= max) return text
    var end = max
    if (text[end - 1].isHighSurrogate()) end--
    return text.substring(0, end) + "…"
}
