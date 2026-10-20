package com.parallelcode.phone

import android.content.SharedPreferences
import androidx.core.content.edit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SettingsStoreTest {

    private lateinit var prefs: FakeSharedPreferences
    private lateinit var store: SettingsStore

    @Before
    fun setUp() {
        prefs = FakeSharedPreferences()
        store = SettingsStore(prefs)
    }

    @Test
    fun defaultsToKeepScreenOnDisabled() {
        assertFalse(store.keepScreenOn)
    }

    @Test
    fun savesHomeWifiTrimmedAndClearsWhenBlank() {
        assertEquals(null, store.homeWifiSsid)
        store.homeWifiSsid = "  Home Net "
        assertEquals("Home Net", store.homeWifiSsid)
        store.homeWifiSsid = "   "
        assertEquals(null, store.homeWifiSsid)
        assertFalse(prefs.contains(SettingsStore.KEY_HOME_WIFI_SSID))
    }

    @Test
    fun defaultsToWaitForVpnDisabled() {
        assertFalse(store.waitForVpn)
    }

    @Test
    fun enablesWaitForVpnAndPersists() {
        store.waitForVpn = true
        assertTrue(store.waitForVpn)
        assertTrue(prefs.getBoolean(SettingsStore.KEY_WAIT_FOR_VPN, false))
    }

    @Test
    fun togglesWaitForVpnBackToDisabled() {
        store.waitForVpn = true
        assertTrue(store.waitForVpn)
        store.waitForVpn = false
        assertFalse(store.waitForVpn)
        assertFalse(prefs.getBoolean(SettingsStore.KEY_WAIT_FOR_VPN, true))
    }

    @Test
    fun enablesKeepScreenOnAndPersists() {
        store.keepScreenOn = true
        assertTrue(store.keepScreenOn)
        assertTrue(prefs.getBoolean(SettingsStore.KEY_KEEP_SCREEN_ON, false))
    }

    @Test
    fun togglesKeepScreenOnBackToDisabled() {
        store.keepScreenOn = true
        assertTrue(store.keepScreenOn)
        store.keepScreenOn = false
        assertFalse(store.keepScreenOn)
        assertFalse(prefs.getBoolean(SettingsStore.KEY_KEEP_SCREEN_ON, true))
    }

    @Test
    fun defaultsToKeepScreenOnOnlyWhenActiveDisabled() {
        assertFalse(store.keepScreenOnOnlyWhenActive)
    }

    @Test
    fun enablesKeepScreenOnOnlyWhenActiveAndPersists() {
        store.keepScreenOnOnlyWhenActive = true
        assertTrue(store.keepScreenOnOnlyWhenActive)
        assertTrue(prefs.getBoolean(SettingsStore.KEY_KEEP_SCREEN_ON_ONLY_ACTIVE, false))
    }

    @Test
    fun defaultsToSystemThemeMode() {
        assertEquals(SettingsStore.THEME_SYSTEM, store.themeMode)
    }

    @Test
    fun defaultsLookPresetsToObsidianPerTone() {
        assertEquals(LookPresets.PRESET_OBSIDIAN, store.darkThemePreset)
        assertEquals(LookPresets.PRESET_OBSIDIAN_LIGHT, store.lightThemePreset)
    }

    @Test
    fun setsLookPresetsAndPersists() {
        store.darkThemePreset = "catppuccin-mocha"
        store.lightThemePreset = "islands-light"
        assertEquals("catppuccin-mocha", store.darkThemePreset)
        assertEquals("islands-light", store.lightThemePreset)
    }

    @Test
    fun lookPresetsSurviveSeparateToneSlots() {
        store.darkThemePreset = "ember"
        store.lightThemePreset = "islands-light"
        assertEquals("ember", store.darkThemePreset)
        assertEquals("islands-light", store.lightThemePreset)
    }

    @Test
    fun unknownLookPresetFallsBackToToneDefault() {
        prefs.edit { putString(SettingsStore.KEY_DARK_THEME_PRESET, "solarized-ultra") }
        prefs.edit { putString(SettingsStore.KEY_LIGHT_THEME_PRESET, "solarized-ultra") }
        assertEquals(LookPresets.PRESET_OBSIDIAN, store.darkThemePreset)
        assertEquals(LookPresets.PRESET_OBSIDIAN_LIGHT, store.lightThemePreset)
    }

    /** A light look saved into the dark slot must not be drawn in dark mode. */
    @Test
    fun lightPresetInDarkSlotFallsBackToDarkDefault() {
        prefs.edit { putString(SettingsStore.KEY_DARK_THEME_PRESET, LookPresets.PRESET_OBSIDIAN_LIGHT) }
        assertEquals(LookPresets.PRESET_OBSIDIAN, store.darkThemePreset)
    }

    @Test
    fun darkPresetInLightSlotFallsBackToLightDefault() {
        prefs.edit { putString(SettingsStore.KEY_LIGHT_THEME_PRESET, LookPresets.PRESET_OBSIDIAN) }
        assertEquals(LookPresets.PRESET_OBSIDIAN_LIGHT, store.lightThemePreset)
    }

    /** Assigning the wrong tone normalizes on write instead of storing a mismatch. */
    @Test
    fun writingWrongTonePresetNormalizes() {
        store.lightThemePreset = LookPresets.PRESET_OBSIDIAN
        assertEquals(LookPresets.PRESET_OBSIDIAN_LIGHT, store.lightThemePreset)
        assertEquals(LookPresets.PRESET_OBSIDIAN_LIGHT, prefs.getString(SettingsStore.KEY_LIGHT_THEME_PRESET, null))
    }

    @Test
    fun setsThemeModeAndPersists() {
        store.themeMode = SettingsStore.THEME_DARK
        assertEquals(SettingsStore.THEME_DARK, store.themeMode)
        assertEquals(SettingsStore.THEME_DARK, prefs.getString(SettingsStore.KEY_THEME_MODE, null))

        store.themeMode = SettingsStore.THEME_LIGHT
        assertEquals(SettingsStore.THEME_LIGHT, store.themeMode)
        assertEquals(SettingsStore.THEME_LIGHT, prefs.getString(SettingsStore.KEY_THEME_MODE, null))
    }

    @Test
    fun defaultsToShowMinimizedTasksDisabled() {
        assertFalse(store.showMinimizedTasks)
    }

    @Test
    fun enablesShowMinimizedTasksAndPersists() {
        store.showMinimizedTasks = true
        assertTrue(store.showMinimizedTasks)
        assertTrue(prefs.getBoolean(SettingsStore.KEY_SHOW_MINIMIZED_TASKS, false))

        store.showMinimizedTasks = false
        assertFalse(store.showMinimizedTasks)
        assertFalse(prefs.getBoolean(SettingsStore.KEY_SHOW_MINIMIZED_TASKS, true))
    }

    @Test
    fun quickRepliesDefaultAndDropBlankLines() {
        assertEquals(SettingsStore.DEFAULT_QUICK_REPLIES, store.quickReplies)
        store.quickReplies = listOf(" continue ", "", "ship it")
        assertEquals(listOf("continue", "ship it"), store.quickReplies)
    }

    @Test
    fun appendsToADraftLikeTyping() {
        assertEquals("yes", appendToDraft("  ", "yes"))
        assertEquals("ok yes", appendToDraft("ok", "yes"))
        assertEquals("ok yes", appendToDraft("ok ", "yes"))
    }

    @Test
    fun sendQuickRepliesDefaultsOffAndPersists() {
        assertFalse(store.sendQuickReplies)
        store.sendQuickReplies = true
        assertTrue(store.sendQuickReplies)
        assertTrue(prefs.getBoolean(SettingsStore.KEY_SEND_QUICK_REPLIES, false))
    }

    @Test
    fun alwaysFollowOutputDefaultsOffAndPersists() {
        assertFalse(store.alwaysFollowOutput)
        store.alwaysFollowOutput = true
        assertTrue(store.alwaysFollowOutput)
        assertTrue(prefs.getBoolean(SettingsStore.KEY_ALWAYS_FOLLOW_OUTPUT, false))
    }

    @Test
    fun widgetTransparencyDefaultsToOpaqueAndPersists() {
        assertEquals(100, store.widgetTransparency)
        store.widgetTransparency = 50
        assertEquals(50, store.widgetTransparency)
        assertEquals(50, prefs.getInt(SettingsStore.KEY_WIDGET_TRANSPARENCY, 100))
    }

    @Test
    fun widgetTransparencySnapsToAStopOnTheWayInAndOut() {
        store.widgetTransparency = 90
        assertEquals(100, store.widgetTransparency)
        assertEquals(100, prefs.getInt(SettingsStore.KEY_WIDGET_TRANSPARENCY, 0))

        // A value written by an older build still reads back as a real stop.
        prefs.edit().putInt(SettingsStore.KEY_WIDGET_TRANSPARENCY, 42).apply()
        assertEquals(50, store.widgetTransparency)
    }

    @Test
    fun widgetPaletteDefaultsToObsidianAndPersists() {
        assertEquals("obsidian", store.widgetPalette)
        store.widgetPalette = "light"
        assertEquals("light", store.widgetPalette)
        assertEquals("light", prefs.getString(SettingsStore.KEY_WIDGET_PALETTE, null))
    }

    @Test
    fun unknownWidgetPaletteFallsBackToObsidian() {
        store.widgetPalette = "chartreuse"
        assertEquals("obsidian", store.widgetPalette)
        assertEquals("obsidian", prefs.getString(SettingsStore.KEY_WIDGET_PALETTE, null))
    }
}
