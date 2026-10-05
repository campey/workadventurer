package app.workadventurer.protocol

import java.io.ByteArrayOutputStream

/** The pusher's outer frame (not in the public protos): {1: seq varint, 2: inner bytes}; field 2 may repeat. */
object Envelope {
    fun wrap(seq: Long, payload: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0x08)
        writeVarint(out, seq)
        out.write(0x12)
        writeVarint(out, payload.size.toLong())
        out.write(payload)
        return out.toByteArray()
    }

    fun unwrap(frame: ByteArray): List<ByteArray> {
        val payloads = mutableListOf<ByteArray>()
        var pos = 0
        fun varint(): Long {
            var shift = 0
            var result = 0L
            while (true) {
                require(pos < frame.size) { "truncated varint" }
                val b = frame[pos++].toInt() and 0xff
                result = result or ((b and 0x7f).toLong() shl shift)
                if (b and 0x80 == 0) return result
                shift += 7
                require(shift < 64) { "varint too long" }
            }
        }
        while (pos < frame.size) {
            val tag = varint().toInt()
            val field = tag ushr 3
            when (tag and 7) {
                0 -> varint() // seq or any unknown varint field
                2 -> {
                    val len = varint().toInt()
                    require(len >= 0 && pos + len <= frame.size) { "truncated payload" }
                    if (field == 2) payloads += frame.copyOfRange(pos, pos + len)
                    pos += len
                }
                else -> throw IllegalArgumentException("unsupported wire type ${tag and 7}")
            }
        }
        return payloads
    }

    private fun writeVarint(out: ByteArrayOutputStream, value: Long) {
        var v = value
        do {
            var b = (v and 0x7f).toInt()
            v = v ushr 7
            if (v != 0L) b = b or 0x80
            out.write(b)
        } while (v != 0L)
    }
}
