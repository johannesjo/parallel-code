package com.parallelcode.phone

import android.content.SharedPreferences
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject

/** A desktop this phone has linked to, by its Remote Access address. */
data class SavedComputer(
    val baseUrl: String,
    val token: String,
    val pairedToken: String?,
    /** A name the user gave this computer; null means it has none. */
    val alias: String? = null,
) {
    /** What the phone shows for this computer: its name, or "192.168.1.20:7777". */
    val label: String get() = alias?.takeIf { it.isNotBlank() } ?: baseUrl.substringAfter("://")
}

/**
 * The desktops this phone is linked to, and which one it uses. The view-only token comes from the
 * QR code; the paired token is minted by entering the desktop's PIN and is the one allowed to type.
 * Computers are keyed by address. App-private storage with backups disabled in the manifest.
 */
class CredentialStore(private val prefs: SharedPreferences) {

    init {
        migrateSingleComputer()
    }

    val computers: List<SavedComputer>
        get() = runCatching { parseComputers(prefs.getString(KEY_COMPUTERS, "[]") ?: "[]") }.getOrElse { emptyList() }

    private val active: SavedComputer?
        get() = prefs.getString(KEY_ACTIVE, null)?.let { url -> computers.firstOrNull { it.baseUrl == url } }

    val link: ConnectionLink?
        get() = active?.let { ConnectionLink(it.baseUrl, it.token) }

    val pairedToken: String?
        get() = active?.pairedToken

    /**
     * Use [link]'s computer, adding it if new. A new QR token for a known address may belong to a
     * different computer now, so it drops that address's paired token, but keeps its name.
     */
    fun saveLink(link: ConnectionLink) {
        val alias = computers.firstOrNull { it.baseUrl == link.baseUrl }?.alias
        val others = computers.filter { it.baseUrl != link.baseUrl }
        write(others + SavedComputer(link.baseUrl, link.token, null, alias), active = link.baseUrl)
    }

    /** Switch to a saved computer. */
    fun select(baseUrl: String) {
        if (computers.any { it.baseUrl == baseUrl }) prefs.edit { putString(KEY_ACTIVE, baseUrl) }
    }

    fun savePairedToken(token: String) = updateActive { it.copy(pairedToken = token) }

    fun clearPairedToken() = updateActive { it.copy(pairedToken = null) }

    /** Name a saved computer; a blank name clears the one it had. */
    fun rename(baseUrl: String, alias: String?) {
        val current = prefs.getString(KEY_ACTIVE, null)
        write(
            computers.map { if (it.baseUrl == baseUrl) it.copy(alias = alias?.trim()?.takeIf { it.isNotEmpty() }) else it },
            active = current,
        )
    }

    /** Forget a saved computer; forgetting the one in use leaves none selected. */
    fun remove(baseUrl: String) {
        val current = prefs.getString(KEY_ACTIVE, null)
        write(computers.filter { it.baseUrl != baseUrl }, active = current.takeIf { it != baseUrl })
    }

    /** Forget the computer in use. */
    fun clear() {
        prefs.getString(KEY_ACTIVE, null)?.let(::remove)
    }

    private fun updateActive(change: (SavedComputer) -> SavedComputer) {
        val url = prefs.getString(KEY_ACTIVE, null) ?: return
        write(computers.map { if (it.baseUrl == url) change(it) else it }, active = url)
    }

    private fun write(list: List<SavedComputer>, active: String?) {
        prefs.edit {
            putString(KEY_COMPUTERS, serializeComputers(list))
            if (active == null) remove(KEY_ACTIVE) else putString(KEY_ACTIVE, active)
        }
    }

    /** Earlier versions kept one computer in flat keys; carry it over, pairing included. */
    private fun migrateSingleComputer() {
        val baseUrl = prefs.getString(LEGACY_BASE_URL, null) ?: return
        val token = prefs.getString(LEGACY_TOKEN, null)
        if (token != null && !prefs.contains(KEY_COMPUTERS)) {
            write(listOf(SavedComputer(baseUrl, token, prefs.getString(LEGACY_PAIRED_TOKEN, null))), active = baseUrl)
        }
        prefs.edit {
            remove(LEGACY_BASE_URL)
            remove(LEGACY_TOKEN)
            remove(LEGACY_PAIRED_TOKEN)
        }
    }

    companion object {
        const val PREFS_NAME = "desktop"
        private const val KEY_COMPUTERS = "computers"
        private const val KEY_ACTIVE = "active"
        private const val LEGACY_BASE_URL = "baseUrl"
        private const val LEGACY_TOKEN = "token"
        private const val LEGACY_PAIRED_TOKEN = "pairedToken"

        private fun serializeComputers(list: List<SavedComputer>): String {
            val array = JSONArray()
            list.forEach {
                array.put(
                    JSONObject()
                        .put("baseUrl", it.baseUrl)
                        .put("token", it.token)
                        .put("pairedToken", it.pairedToken ?: JSONObject.NULL)
                        .put("alias", it.alias ?: JSONObject.NULL),
                )
            }
            return array.toString()
        }

        /**
         * [values], a whole copy of this store's preferences, with every paired token dropped: what an
         * unencrypted backup may hold. The view-only tokens stay, so a restore only needs the PINs again.
         */
        fun withoutPairedTokens(values: Map<String, *>): Map<String, *> {
            val json = values[KEY_COMPUTERS] as? String ?: return values
            val computers = runCatching { parseComputers(json) }.getOrNull() ?: return values - KEY_COMPUTERS
            return values + (KEY_COMPUTERS to serializeComputers(computers.map { it.copy(pairedToken = null) }))
        }

        private fun parseComputers(json: String): List<SavedComputer> {
            val array = JSONArray(json)
            return List(array.length()) { i ->
                val c = array.getJSONObject(i)
                SavedComputer(
                    c.getString("baseUrl"),
                    c.getString("token"),
                    if (c.isNull("pairedToken")) null else c.optString("pairedToken").ifEmpty { null },
                    // Written by newer builds; missing on older ones.
                    if (c.isNull("alias")) null else c.optString("alias").ifEmpty { null },
                )
            }
        }

        /**
         * Whether [values], a whole copy of this store's preferences (as a backup holds them),
         * describes computers this phone can connect to: Remote Access addresses with tokens, and an
         * active one among them.
         */
        fun isValid(values: Map<String, Any>): Boolean {
            val json = values[KEY_COMPUTERS] ?: return !values.containsKey(KEY_ACTIVE)
            val computers = (json as? String)?.let { runCatching { parseComputers(it) }.getOrNull() } ?: return false
            val wellFormed = computers.all { c ->
                c.token.isNotEmpty() && ConnectionLink.parse("${c.baseUrl}/?token=t")?.baseUrl == c.baseUrl
            }
            val active = values[KEY_ACTIVE]
            return wellFormed && (active == null || computers.any { it.baseUrl == active })
        }
    }
}
