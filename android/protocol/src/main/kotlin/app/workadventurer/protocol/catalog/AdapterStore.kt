package app.workadventurer.protocol.catalog

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

/** Cache of downloaded adapter files, keyed by hash. */
interface AdapterStore {
    /** The valid adapter cached under [hash], or null if missing, corrupt, invalid or filed under the wrong hash. Never throws. */
    fun load(hash: String): AdapterFile?

    /** Persist the raw adapter text; may throw (the caller treats that as a failure). */
    fun save(hash: String, text: String)
}

/** One `<hash>.json` per adapter in [dir]; writes are atomic (temp file in the same directory, then rename). */
class FileAdapterStore(private val dir: File) : AdapterStore {
    override fun load(hash: String): AdapterFile? {
        if (!HASH_RE.matches(hash)) return null
        return try {
            val f = File(dir, "$hash.json")
            if (f.length() > CatalogClient.MAX_FILE_BYTES) return null
            val parsed = parseJsonBytes(f.readBytes()) as? Parsed.Value ?: return null
            val checked = validateAdapterFile(parsed.json) as? Checked.Ok ?: return null
            checked.file.takeIf { it.apiVersionHash == hash }
        } catch (e: Exception) {
            null
        }
    }

    override fun save(hash: String, text: String) {
        require(HASH_RE.matches(hash)) { "invalid adapter hash \"$hash\"" }
        dir.mkdirs()
        val tmp = File(dir, "$hash.${UUID.randomUUID()}.tmp")
        try {
            tmp.writeBytes(text.toByteArray(Charsets.UTF_8))
            Files.move(tmp.toPath(), File(dir, "$hash.json").toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            tmp.delete()
        }
    }
}
