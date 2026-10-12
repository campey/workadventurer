package app.workadventurer.voice

private val KEPT = listOf("m=", "a=group:", "a=mid:", "a=rtpmap:", "a=extmap:", "a=setup:", "a=sendrecv", "a=sendonly", "a=recvonly", "a=inactive")

/**
 * What an SDP looks like, for the call log when we can't use it: its size and its media sections, codecs and header
 * extensions, which is where an unparseable offer differs. An allowlist, so addresses, candidates, ICE credentials and
 * fingerprints can never reach the log.
 */
fun sdpShape(sdp: String): String {
    val lines = sdp.split("\r\n", "\n").filter { it.isNotBlank() }
    val kept = lines.filter { l -> KEPT.any { l.startsWith(it) } }
    val head = "sdp ${sdp.length} bytes, ${lines.size} lines"
    return if (kept.isEmpty()) head else "$head: ${kept.joinToString(" | ")}"
}
