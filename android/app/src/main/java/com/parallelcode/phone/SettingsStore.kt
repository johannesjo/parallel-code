package com.parallelcode.phone

import android.content.SharedPreferences
import androidx.core.content.edit

class SettingsStore(private val prefs: SharedPreferences) {

    var keepScreenOn: Boolean
        get() = prefs.getBoolean(KEY_KEEP_SCREEN_ON, false)
        set(value) {
            prefs.edit { putBoolean(KEY_KEEP_SCREEN_ON, value) }
        }

    var keepScreenOnOnlyWhenActive: Boolean
        get() = prefs.getBoolean(KEY_KEEP_SCREEN_ON_ONLY_ACTIVE, false)
        set(value) {
            prefs.edit { putBoolean(KEY_KEEP_SCREEN_ON_ONLY_ACTIVE, value) }
        }

    /**
     * Which tone to draw in: [THEME_SYSTEM] follows Android, the other two force it.
     * The palette itself is [darkThemePreset] or [lightThemePreset], as on the desktop.
     */
    var themeMode: String
        get() = prefs.getString(KEY_THEME_MODE, THEME_SYSTEM) ?: THEME_SYSTEM
        set(value) {
            prefs.edit { putString(KEY_THEME_MODE, value) }
        }

    /** Preset drawn while in dark mode; unknown or wrong-tone ids read back as Obsidian. */
    var darkThemePreset: String
        get() = LookPresets.forTone(dark = true, id = prefs.getString(KEY_DARK_THEME_PRESET, null)).id
        set(value) {
            val preset = LookPresets.forTone(dark = true, id = value)
            prefs.edit { putString(KEY_DARK_THEME_PRESET, preset.id) }
        }

    /** Preset drawn while in light mode; unknown or wrong-tone ids read back as Obsidian Light. */
    var lightThemePreset: String
        get() = LookPresets.forTone(dark = false, id = prefs.getString(KEY_LIGHT_THEME_PRESET, null)).id
        set(value) {
            val preset = LookPresets.forTone(dark = false, id = value)
            prefs.edit { putString(KEY_LIGHT_THEME_PRESET, preset.id) }
        }

    var showMinimizedTasks: Boolean
        get() = prefs.getBoolean(KEY_SHOW_MINIMIZED_TASKS, false)
        set(value) {
            prefs.edit { putBoolean(KEY_SHOW_MINIMIZED_TASKS, value) }
        }

    /** Jump to new terminal output even when scrolled up; off, output is followed only at the bottom. */
    var alwaysFollowOutput: Boolean
        get() = prefs.getBoolean(KEY_ALWAYS_FOLLOW_OUTPUT, false)
        set(value) {
            prefs.edit { putBoolean(KEY_ALWAYS_FOLLOW_OUTPUT, value) }
        }

    /**
     * Give a viewed terminal the phone's size, so full-screen agents fill the phone. Off by default:
     * while on, the desktop pane shows output drawn for the phone and shifts until you leave.
     */
    var fitTerminalToPhone: Boolean
        get() = prefs.getBoolean(KEY_FIT_TERMINAL, false)
        set(value) = prefs.edit { putBoolean(KEY_FIT_TERMINAL, value) }

    /** Replies offered above the reply box, one per line. */
    var quickReplies: List<String>
        get() = (prefs.getString(KEY_QUICK_REPLIES, null) ?: DEFAULT_QUICK_REPLIES.joinToString("\n"))
            .lines().map { it.trim() }.filter { it.isNotEmpty() }
        set(value) = prefs.edit { putString(KEY_QUICK_REPLIES, value.joinToString("\n")) }

    /** Send a quick reply immediately when tapped, instead of adding it to the draft. */
    var sendQuickReplies: Boolean
        get() = prefs.getBoolean(KEY_SEND_QUICK_REPLIES, false)
        set(value) = prefs.edit { putBoolean(KEY_SEND_QUICK_REPLIES, value) }

    /**
     * How opaque the home-screen widget's card is, as one of [WIDGET_TRANSPARENCY_STEPS]. Lower
     * values show more wallpaper through the card; its border fades with the fill.
     */
    var widgetTransparency: Int
        get() = widgetTransparencyStep(prefs.getInt(KEY_WIDGET_TRANSPARENCY, 100))
        set(value) = prefs.edit { putInt(KEY_WIDGET_TRANSPARENCY, widgetTransparencyStep(value)) }

    /** The widget's card color, as a [WIDGET_PALETTES] key; unknown keys read back as Obsidian. */
    var widgetPalette: String
        get() = widgetPalette(prefs.getString(KEY_WIDGET_PALETTE, null)).key
        set(value) = prefs.edit { putString(KEY_WIDGET_PALETTE, widgetPalette(value).key) }

    /** Keep watching in the background and notify about agents (see [AgentWatchService]). */
    var notificationsEnabled: Boolean
        get() = prefs.getBoolean(KEY_NOTIFICATIONS, false)
        set(value) = prefs.edit { putBoolean(KEY_NOTIFICATIONS, value) }

    var notifyNeedsInput: Boolean
        get() = prefs.getBoolean(KEY_NOTIFY_NEEDS_INPUT, true)
        set(value) = prefs.edit { putBoolean(KEY_NOTIFY_NEEDS_INPUT, value) }

    var notifyErrors: Boolean
        get() = prefs.getBoolean(KEY_NOTIFY_ERRORS, true)
        set(value) = prefs.edit { putBoolean(KEY_NOTIFY_ERRORS, value) }

    var notifyFinished: Boolean
        get() = prefs.getBoolean(KEY_NOTIFY_FINISHED, false)
        set(value) = prefs.edit { putBoolean(KEY_NOTIFY_FINISHED, value) }

    /** Wait to connect until an active VPN (such as Tailscale or WireGuard) is up. */
    var waitForVpn: Boolean
        get() = prefs.getBoolean(KEY_WAIT_FOR_VPN, false)
        set(value) = prefs.edit { putBoolean(KEY_WAIT_FOR_VPN, value) }

    /** On this Wi-Fi network, connect without waiting for a VPN. Null when unset. */
    var homeWifiSsid: String?
        get() = prefs.getString(KEY_HOME_WIFI_SSID, null)
        set(value) {
            val ssid = value?.trim()?.ifEmpty { null }
            prefs.edit { if (ssid == null) remove(KEY_HOME_WIFI_SSID) else putString(KEY_HOME_WIFI_SSID, ssid) }
        }

    fun notifiesFor(event: AgentEvent): Boolean = when (event) {
        AgentEvent.NEEDS_INPUT -> notifyNeedsInput
        AgentEvent.ERROR -> notifyErrors
        AgentEvent.FINISHED -> notifyFinished
    }

    companion object {
        const val PREFS_NAME = "settings"
        const val KEY_WAIT_FOR_VPN = "waitForVpn"
        const val KEY_HOME_WIFI_SSID = "homeWifiSsid"
        const val KEY_KEEP_SCREEN_ON = "keepScreenOn"
        const val KEY_KEEP_SCREEN_ON_ONLY_ACTIVE = "keepScreenOnOnlyActive"
        const val KEY_THEME_MODE = "themeMode"
        const val KEY_DARK_THEME_PRESET = "darkThemePreset"
        const val KEY_LIGHT_THEME_PRESET = "lightThemePreset"
        const val KEY_SHOW_MINIMIZED_TASKS = "showMinimizedTasks"
        const val KEY_ALWAYS_FOLLOW_OUTPUT = "alwaysFollowOutput"
        const val KEY_FIT_TERMINAL = "fitTerminalToPhone"
        const val KEY_QUICK_REPLIES = "quickReplies"
        const val KEY_SEND_QUICK_REPLIES = "sendQuickReplies"
        val DEFAULT_QUICK_REPLIES = listOf("continue", "yes", "run the tests", "commit this")
        const val KEY_NOTIFICATIONS = "notifications"
        const val KEY_NOTIFY_NEEDS_INPUT = "notifyNeedsInput"
        const val KEY_NOTIFY_ERRORS = "notifyErrors"
        const val KEY_NOTIFY_FINISHED = "notifyFinished"
        const val KEY_WIDGET_TRANSPARENCY = "widgetTransparency"
        const val KEY_WIDGET_PALETTE = "widgetPalette"

        const val THEME_SYSTEM = "system"
        const val THEME_DARK = "dark"
        const val THEME_LIGHT = "light"
    }
}
