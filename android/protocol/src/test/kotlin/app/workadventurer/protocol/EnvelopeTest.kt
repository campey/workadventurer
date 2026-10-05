package app.workadventurer.protocol

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class EnvelopeTest {
    private fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    @Test
    fun wrapMatchesNodeClientBytes() {
        // Node: _wrap(Buffer [0x0a,0x00]) with _outSeq=1 -> 08 01 12 02 0a 00
        assertContentEquals(bytes(0x08, 0x01, 0x12, 0x02, 0x0a, 0x00), Envelope.wrap(1, bytes(0x0a, 0x00)))
    }

    @Test
    fun unwrapReadsSeveralPayloadsInOneFrame() {
        val frame = bytes(0x08, 0x05, 0x12, 0x01, 0xaa, 0x12, 0x01, 0xbb)
        val out = Envelope.unwrap(frame)
        assertEquals(2, out.size)
        assertContentEquals(bytes(0xaa), out[0])
        assertContentEquals(bytes(0xbb), out[1])
    }

    @Test
    fun payloadLongerThan127BytesUsesMultiByteVarint() {
        val payload = ByteArray(300) { (it % 251).toByte() }
        val frame = Envelope.wrap(300, payload)
        // seq 300 = ac 02 ; len 300 = ac 02
        assertContentEquals(bytes(0x08, 0xac, 0x02, 0x12, 0xac, 0x02), frame.copyOfRange(0, 6))
        val out = Envelope.unwrap(frame)
        assertEquals(1, out.size)
        assertContentEquals(payload, out[0])
    }

    @Test
    fun unwrapSkipsUnknownFields() {
        // field 3 varint (18 01) before a normal payload
        val frame = bytes(0x18, 0x01, 0x08, 0x01, 0x12, 0x01, 0x7f)
        assertContentEquals(bytes(0x7f), Envelope.unwrap(frame).single())
    }

    @Test(expected = IllegalArgumentException::class)
    fun truncatedPayloadThrows() {
        Envelope.unwrap(bytes(0x08, 0x01, 0x12, 0x05, 0x01))
    }
}
