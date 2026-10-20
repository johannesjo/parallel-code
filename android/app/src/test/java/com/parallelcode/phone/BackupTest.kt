package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class BackupTest {
    private fun phone(): Map<String, FakeSharedPreferences> {
        val stores = mapOf(
            CredentialStore.PREFS_NAME to FakeSharedPreferences(),
            SettingsStore.PREFS_NAME to FakeSharedPreferences(),
            PromptHistoryStore.PREFS_NAME to FakeSharedPreferences(),
        )
        CredentialStore(stores.getValue(CredentialStore.PREFS_NAME)).apply {
            saveLink(ConnectionLink("http://192.168.1.20:7777", "view-token"))
            savePairedToken("paired-token")
            rename("http://192.168.1.20:7777", "Desk")
        }
        SettingsStore(stores.getValue(SettingsStore.PREFS_NAME)).apply {
            themeMode = SettingsStore.THEME_DARK
            widgetTransparency = 60
            fitTerminalToPhone = true
        }
        stores.getValue(SettingsStore.PREFS_NAME).edit().putLong("aLong", 5L).putFloat("aFloat", 1.5f)
            .putStringSet("aSet", setOf("a", "b")).apply()
        PromptHistoryStore(stores.getValue(PromptHistoryStore.PREFS_NAME)).record("agent-1", "run the tests")
        return stores
    }

    private fun emptyPhone() = mapOf(
        CredentialStore.PREFS_NAME to FakeSharedPreferences(),
        SettingsStore.PREFS_NAME to FakeSharedPreferences(),
        PromptHistoryStore.PREFS_NAME to FakeSharedPreferences(),
    )

    private fun assertSameData(expected: Map<String, FakeSharedPreferences>, actual: Map<String, FakeSharedPreferences>) {
        expected.forEach { (name, prefs) -> assertEquals(name, prefs.all, actual.getValue(name).all) }
    }

    @Test
    fun `a backup without a password is a plain zip that restores everything but pairing`() {
        val source = phone()
        val bytes = Backup.create(source, null)
        assertFalse(Backup.isEncrypted(bytes))
        assertEquals('P'.code.toByte(), bytes[0]) // zip local file header "PK"
        assertFalse(unzipped(bytes).contains("paired-token"))

        val target = emptyPhone()
        target.getValue(SettingsStore.PREFS_NAME).edit().putBoolean("stale", true).apply()
        Backup.restore(bytes, null, target)

        assertSameData(source - CredentialStore.PREFS_NAME, target)
        val credentials = CredentialStore(target.getValue(CredentialStore.PREFS_NAME))
        assertEquals(null, credentials.pairedToken)
        assertEquals("http://192.168.1.20:7777", credentials.link?.baseUrl)
        assertEquals("view-token", credentials.link?.token)
        assertEquals("Desk", credentials.computers.single().alias)
    }

    @Test
    fun `a backup with a password keeps pairing`() {
        val source = phone()
        val target = emptyPhone()
        Backup.restore(Backup.create(source, "correct horse"), "correct horse", target)

        assertSameData(source, target)
        assertEquals("paired-token", CredentialStore(target.getValue(CredentialStore.PREFS_NAME)).pairedToken)
    }

    /** Every entry of a plain backup, as one string. */
    private fun unzipped(bytes: ByteArray): String {
        val out = StringBuilder()
        java.util.zip.ZipInputStream(bytes.inputStream()).use { zip ->
            while (zip.nextEntry != null) out.append(zip.readBytes().toString(Charsets.UTF_8))
        }
        return out.toString()
    }

    @Test
    fun `a backup with a password restores only with that password`() {
        val source = phone()
        val bytes = Backup.create(source, "correct horse")
        assertTrue(Backup.isEncrypted(bytes))
        assertFalse(String(bytes, Charsets.ISO_8859_1).contains("paired-token"))

        val target = emptyPhone()
        for (wrong in listOf(null, "", "wrong")) {
            try {
                Backup.restore(bytes, wrong, target)
                fail("restored with $wrong")
            } catch (e: BackupException) {
                assertEquals(Backup.WRONG_PASSWORD, e.message)
            }
        }
        assertTrue(target.values.all { it.all.isEmpty() })

        Backup.restore(bytes, "correct horse", target)
        assertSameData(source, target)
    }

    @Test
    fun `a tampered encrypted backup is refused`() {
        val bytes = Backup.create(phone(), "pw")
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        try {
            Backup.restore(bytes, "pw", emptyPhone())
            fail("restored a tampered file")
        } catch (e: BackupException) {
            assertEquals(Backup.WRONG_PASSWORD, e.message)
        }
    }

    @Test
    fun `files that are not backups change nothing`() {
        val target = phone()
        val before = target.mapValues { HashMap(it.value.all) }
        val damagedComputers = zip(
            "backup.json" to """{"format":1}""",
            "desktop.json" to """{"computers":{"type":"string","value":"[{\"baseUrl\":\"file:///etc\",\"token\":\"t\"}]"}}""",
            "settings.json" to "{}",
        )
        for (bytes in listOf("hello".toByteArray(), zip("other.txt" to "x"), damagedComputers)) {
            try {
                Backup.restore(bytes, null, target)
                fail("restored a non-backup")
            } catch (_: BackupException) {
            }
            assertEquals(before, target.mapValues { HashMap(it.value.all) })
        }
    }

    private fun zip(vararg entries: Pair<String, String>): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            entries.forEach { (name, text) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(text.toByteArray())
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }
}
