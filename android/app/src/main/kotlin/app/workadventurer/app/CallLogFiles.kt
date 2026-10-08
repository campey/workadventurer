package app.workadventurer.app

import java.io.BufferedWriter
import java.io.File
import java.net.URI
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * One log file per call (join to leave) in [dir], so what happened in a real call is still there the next day (logcat keeps
 * about an hour). Old files are pruned to [maxFiles] and [maxTotalBytes]; the newest is never pruned. A single file stops
 * growing at [maxFileBytes]. Thread-safe: lines arrive from several coroutines and the library's threads.
 */
class CallLogFiles(
    private val dir: File,
    private val clock: () -> Long = System::currentTimeMillis,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val maxFiles: Int = 20,
    private val maxTotalBytes: Long = 20_000_000,
    private val maxFileBytes: Long = 5_000_000,
) {
    private var writer: BufferedWriter? = null
    private var written = 0L
    private var full = false

    private val nameStamp = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss")
    private val lineStamp = DateTimeFormatter.ofPattern("HH:mm:ss.SSS")
    private fun at(f: DateTimeFormatter) = f.format(Instant.ofEpochMilli(clock()).atZone(zone))

    val isOpen: Boolean @Synchronized get() = writer != null

    /** Closes any open file, then opens a new one for a call to [roomUrl], starting with the [header] lines. */
    @Synchronized
    fun start(roomUrl: String, header: List<String>) {
        end()
        dir.mkdirs()
        val base = "${at(nameStamp)}_${roomSlug(roomUrl)}"
        var file = File(dir, "$base.log")
        var n = 2
        while (file.exists()) file = File(dir, "$base-${n++}.log")
        writer = file.bufferedWriter()
        written = 0
        full = false
        header.forEach { write(it) }
        prune()
    }

    /** Adds one timestamped line to the current file; does nothing when no call is open. */
    @Synchronized
    fun append(tag: String, message: String) {
        if (writer == null || full) return
        val line = "${at(lineStamp)} $tag ${message.replace('\n', ' ').replace('\r', ' ').take(MAX_MESSAGE)}"
        if (written + line.length + 1 > maxFileBytes) {
            write("${at(lineStamp)} CallLog log full ($maxFileBytes bytes), no more lines in this file")
            full = true
            return
        }
        write(line)
    }

    @Synchronized
    fun end() {
        try { writer?.close() } catch (_: Exception) {}
        writer = null
        prune()
    }

    private fun write(line: String) {
        val w = writer ?: return
        try {
            w.write(line); w.newLine(); w.flush()
            written += line.length + 1
        } catch (_: Exception) {
            // Out of space or the directory vanished: a diagnostic log must never take the call down with it.
            writer = null
        }
    }

    /** Oldest first goes, until both limits hold. The newest file stays even if it alone is over the total. */
    private fun prune() {
        val all = dir.listFiles { f -> f.isFile && f.name.endsWith(".log") }?.sortedBy { it.name }?.toMutableList() ?: return
        var total = all.sumOf { it.length() }
        while (all.size > 1 && (all.size > maxFiles || total > maxTotalBytes)) {
            val oldest = all.removeAt(0)
            total -= oldest.length()
            oldest.delete()
        }
    }

    private companion object { const val MAX_MESSAGE = 1_000 }
}

/** A filename-safe summary of a room URL: its path words, `staging-` first for the staging server. */
fun roomSlug(roomUrl: String): String {
    val uri = runCatching { URI(roomUrl.trim()) }.getOrNull() ?: return "room"
    val words = uri.path.orEmpty().split('/').filter { it.isNotEmpty() && it != "@" }.joinToString("-").lowercase()
        .map { if (it in 'a'..'z' || it in '0'..'9') it else '-' }.joinToString("")
        .replace(Regex("-+"), "-").trim('-')
    if (words.isEmpty()) return "room"
    val staged = if (uri.host.orEmpty().contains("staging")) "staging-$words" else words
    return staged.take(60).trimEnd('-')
}
