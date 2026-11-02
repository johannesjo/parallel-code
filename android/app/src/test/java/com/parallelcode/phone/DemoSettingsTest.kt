package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DemoSettingsTest {
    @Test
    fun `sessions have disposable independent settings credentials and history`() {
        val demo = DemoSettings()
        val other = DemoSettings()
        demo.settings.themeMode = SettingsStore.THEME_LIGHT
        demo.settings.quickReplies = listOf("Review this")
        demo.credentials.rename(DemoSettings.PRIMARY_URL, "Changed")
        demo.history.record("demo-review", "Only in this session")

        assertEquals(SettingsStore.THEME_SYSTEM, other.settings.themeMode)
        assertNotEquals(demo.settings.quickReplies, other.settings.quickReplies)
        assertEquals("Review workstation", other.credentials.computers.last().alias)
        assertEquals(listOf("Show the sample changes"), other.history.history("demo-review"))
        assertTrue(demo.credentials.computers.all { it.baseUrl.endsWith(".demo.invalid") })
        assertNull(other.backup)
    }

    @Test
    fun `plain backup restores demo settings computers and history but drops pairing`() {
        val demo = DemoSettings()
        demo.settings.quickReplies = listOf("Saved reply")
        demo.createBackup(null)
        assertFalse(Backup.isEncrypted(requireNotNull(demo.backup)))
        demo.settings.quickReplies = listOf("Changed reply")
        demo.credentials.remove(DemoSettings.SECONDARY_URL)
        demo.history.record("demo-review", "After backup")

        demo.restoreBackup(null)

        assertEquals(listOf("Saved reply"), demo.settings.quickReplies)
        assertEquals(2, demo.credentials.computers.size)
        assertTrue(demo.credentials.computers.all { it.pairedToken == null })
        assertEquals(listOf("Show the sample changes"), demo.history.history("demo-review"))
    }

    @Test
    fun `encrypted backup checks password before changing demo data and preserves fake pairing`() {
        val demo = DemoSettings()
        demo.createBackup("review password")
        assertTrue(Backup.isEncrypted(requireNotNull(demo.backup)))
        demo.settings.themeMode = SettingsStore.THEME_LIGHT
        try {
            demo.restoreBackup("incorrect")
            fail("Wrong password must fail")
        } catch (failure: BackupException) {
            assertEquals(Backup.WRONG_PASSWORD, failure.message)
        }
        assertEquals(SettingsStore.THEME_LIGHT, demo.settings.themeMode)
        demo.restoreBackup("review password")
        assertEquals(SettingsStore.THEME_SYSTEM, demo.settings.themeMode)
        assertEquals("demo-paired-workstation", demo.credentials.pairedToken)
    }

    @Test
    fun `preference snapshots and string sets cannot mutate the demo store`() {
        val prefs = MemoryPreferences()
        val source = mutableSetOf("sample")
        prefs.edit().putStringSet("set", source).apply()
        source += "changed"
        assertEquals(setOf("sample"), prefs.getStringSet("set", null))
        val snapshot = prefs.all
        prefs.edit().clear().putBoolean("enabled", true).commit()
        assertEquals(setOf("sample"), snapshot["set"])
        assertEquals(mapOf("enabled" to true), prefs.all)
    }
}
