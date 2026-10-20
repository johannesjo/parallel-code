package com.parallelcode.phone

import android.content.SharedPreferences
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.zip.ZipEntry
import java.util.zip.ZipException
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** A backup that cannot be read or restored, with a message to show as is. */
class BackupException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Backs up the phone's saved data (computers and their tokens, settings, prompt history): a zip of
 * one JSON file per preferences file. With a password, the zip is encrypted with AES-256-GCM under
 * a PBKDF2 key, behind a header that marks the file as encrypted. Without one, paired tokens are
 * left out: they let whoever holds the file type to the agents.
 */
object Backup {
    private const val FORMAT = 1
    private const val MANIFEST = "backup.json"
    private val MAGIC = "PCBACKUP".toByteArray(Charsets.US_ASCII)
    private const val ITERATIONS = 600_000
    private const val SALT_BYTES = 16
    private const val IV_BYTES = 12
    private const val HEADER_BYTES = 8 + 1 + 4 + SALT_BYTES + IV_BYTES

    /** Backups are a few KB; refusing anything far larger keeps a hostile file from filling memory. */
    const val MAX_BYTES = 4 * 1024 * 1024

    private const val NOT_A_BACKUP = "That file isn't a Parallel Code backup."
    const val WRONG_PASSWORD = "Wrong password, or the backup is damaged."

    fun create(stores: Map<String, SharedPreferences>, password: String?): ByteArray {
        val plain = password.isNullOrEmpty()
        val zip = ByteArrayOutputStream()
        ZipOutputStream(zip).use { out ->
            fun entry(name: String, json: String) {
                out.putNextEntry(ZipEntry(name))
                out.write(json.toByteArray())
                out.closeEntry()
            }
            entry(MANIFEST, JSONObject().put("format", FORMAT).toString(2))
            stores.forEach { (name, prefs) ->
                val values = if (plain && name == CredentialStore.PREFS_NAME) CredentialStore.withoutPairedTokens(prefs.all) else prefs.all
                entry("$name.json", encode(values).toString(2))
            }
        }
        return if (password.isNullOrEmpty()) zip.toByteArray() else encrypt(zip.toByteArray(), password)
    }

    /** Read a backup file, refusing one larger than [MAX_BYTES]. */
    fun read(input: InputStream): ByteArray = input.readAtMost(MAX_BYTES)

    fun isEncrypted(bytes: ByteArray): Boolean =
        bytes.size >= MAGIC.size && bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)

    /**
     * Replace each of [stores] that the backup holds with its copy there; stores it lacks are left
     * as they are. Nothing is written unless the whole backup reads cleanly.
     */
    fun restore(bytes: ByteArray, password: String?, stores: Map<String, SharedPreferences>) {
        val zip = if (isEncrypted(bytes)) {
            decrypt(bytes, password?.takeIf { it.isNotEmpty() } ?: throw BackupException(WRONG_PASSWORD))
        } else {
            bytes
        }
        val files = readZip(zip)
        val format = files[MANIFEST]?.let { runCatching { JSONObject(it).getInt("format") }.getOrNull() }
        when {
            format == null -> throw BackupException(NOT_A_BACKUP)
            format > FORMAT -> throw BackupException("This backup is from a newer version of the app. Update the app and try again.")
        }
        val restored = stores.keys.mapNotNull { name -> files["$name.json"]?.let { name to decode(it) } }.toMap()
        if (restored.isEmpty()) throw BackupException(NOT_A_BACKUP)
        restored[CredentialStore.PREFS_NAME]?.let {
            if (!CredentialStore.isValid(it)) throw BackupException("The backup's saved computers are damaged.")
        }
        restored.forEach { (name, values) ->
            stores.getValue(name).edit(commit = true) {
                clear()
                values.forEach { (key, value) -> put(key, value) }
            }
        }
    }

    private fun encode(values: Map<String, *>): JSONObject {
        val out = JSONObject()
        values.forEach { (key, value) ->
            val (type, json) = when (value) {
                is String -> "string" to value
                is Boolean -> "boolean" to value
                is Int -> "int" to value
                is Long -> "long" to value
                is Float -> "float" to value.toDouble()
                is Set<*> -> "stringSet" to JSONArray(value.filterIsInstance<String>())
                else -> return@forEach
            }
            out.put(key, JSONObject().put("type", type).put("value", json))
        }
        return out
    }

    private fun decode(text: String): Map<String, Any> = try {
        val root = JSONObject(text)
        root.keys().asSequence().associateWith { key ->
            val item = root.getJSONObject(key)
            when (item.getString("type")) {
                "string" -> item.getString("value")
                "boolean" -> item.getBoolean("value")
                "int" -> item.getInt("value")
                "long" -> item.getLong("value")
                "float" -> item.getDouble("value").toFloat()
                "stringSet" -> item.getJSONArray("value").let { a -> List(a.length()) { a.getString(it) }.toSet() }
                else -> throw BackupException(NOT_A_BACKUP)
            }
        }
    } catch (e: org.json.JSONException) {
        throw BackupException(NOT_A_BACKUP, e)
    }

    private fun SharedPreferences.Editor.put(key: String, value: Any) {
        @Suppress("UNCHECKED_CAST")
        when (value) {
            is String -> putString(key, value)
            is Boolean -> putBoolean(key, value)
            is Int -> putInt(key, value)
            is Long -> putLong(key, value)
            is Float -> putFloat(key, value)
            is Set<*> -> putStringSet(key, value as Set<String>)
        }
    }

    /** Top-level entries by name, as text; reading stops at [MAX_BYTES] in all. */
    private fun readZip(bytes: ByteArray): Map<String, String> {
        val files = HashMap<String, String>()
        var budget = MAX_BYTES
        try {
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    if (entry.isDirectory || '/' in entry.name) continue
                    val data = zip.readAtMost(budget)
                    budget -= data.size
                    files[entry.name] = data.toString(Charsets.UTF_8)
                }
            }
        } catch (e: ZipException) {
            throw BackupException(NOT_A_BACKUP, e)
        }
        return files
    }

    private fun InputStream.readAtMost(limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val n = read(buffer)
            if (n < 0) return out.toByteArray()
            if (out.size() + n > limit) throw BackupException(NOT_A_BACKUP)
            out.write(buffer, 0, n)
        }
    }

    private fun encrypt(plain: ByteArray, password: String): ByteArray {
        val random = SecureRandom()
        val salt = ByteArray(SALT_BYTES).also(random::nextBytes)
        val iv = ByteArray(IV_BYTES).also(random::nextBytes)
        val header = ByteBuffer.allocate(HEADER_BYTES)
            .put(MAGIC).put(FORMAT.toByte()).putInt(ITERATIONS).put(salt).put(iv).array()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(password, salt, ITERATIONS), GCMParameterSpec(128, iv))
        cipher.updateAAD(header)
        return header + cipher.doFinal(plain)
    }

    private fun decrypt(bytes: ByteArray, password: String): ByteArray {
        if (bytes.size <= HEADER_BYTES) throw BackupException(NOT_A_BACKUP)
        val buffer = ByteBuffer.wrap(bytes, MAGIC.size, HEADER_BYTES - MAGIC.size)
        if (buffer.get().toInt() != FORMAT) {
            throw BackupException("This backup is from a newer version of the app. Update the app and try again.")
        }
        val iterations = buffer.int
        // The count comes from the file: bound it so a crafted one cannot stall the phone.
        if (iterations !in 10_000..10_000_000) throw BackupException(NOT_A_BACKUP)
        val salt = ByteArray(SALT_BYTES).also { buffer.get(it) }
        val iv = ByteArray(IV_BYTES).also { buffer.get(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(password, salt, iterations), GCMParameterSpec(128, iv))
        cipher.updateAAD(bytes, 0, HEADER_BYTES)
        return try {
            cipher.doFinal(bytes, HEADER_BYTES, bytes.size - HEADER_BYTES)
        } catch (e: AEADBadTagException) {
            throw BackupException(WRONG_PASSWORD, e)
        }
    }

    private fun key(password: String, salt: ByteArray, iterations: Int): SecretKeySpec {
        val spec = PBEKeySpec(password.toCharArray(), salt, iterations, 256)
        try {
            return SecretKeySpec(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded, "AES")
        } finally {
            spec.clearPassword()
        }
    }
}
