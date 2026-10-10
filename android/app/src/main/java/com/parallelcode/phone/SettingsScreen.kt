package com.parallelcode.phone

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.material3.OutlinedTextField
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    keepScreenOn: Boolean,
    onKeepScreenOnChange: (Boolean) -> Unit,
    keepScreenOnOnlyActive: Boolean,
    onKeepScreenOnOnlyActiveChange: (Boolean) -> Unit,
    themeMode: String,
    onThemeModeChange: (String) -> Unit,
    darkThemePreset: String,
    onDarkThemePresetChange: (String) -> Unit,
    lightThemePreset: String,
    onLightThemePresetChange: (String) -> Unit,
    showMinimizedTasks: Boolean,
    onShowMinimizedTasksChange: (Boolean) -> Unit,
    alwaysFollowOutput: Boolean,
    onAlwaysFollowOutputChange: (Boolean) -> Unit,
    fitTerminalToPhone: Boolean,
    onFitTerminalToPhoneChange: (Boolean) -> Unit,
    widgetTransparency: Int,
    onWidgetTransparencyChange: (Int) -> Unit,
    widgetPalette: String,
    onWidgetPaletteChange: (String) -> Unit,
    quickReplies: List<String>,
    onQuickRepliesChange: (List<String>) -> Unit,
    sendQuickReplies: Boolean,
    onSendQuickRepliesChange: (Boolean) -> Unit,
    notifications: NotificationPrefs,
    onNotificationsChange: (NotificationPrefs) -> Unit,
    waitForVpn: Boolean,
    onWaitForVpnChange: (Boolean) -> Unit,
    homeWifiSsid: String?,
    onHomeWifiSsidChange: (String?) -> Unit,
    currentWifiSsid: String?,
    onUseCurrentWifi: () -> Unit,
    latencyMs: Long?,
    state: ConnectionState,
    computers: List<SavedComputer>,
    onSwitchComputer: (String) -> Unit,
    onRenameComputer: (String, String?) -> Unit,
    onForgetComputer: (String) -> Unit,
    onAddComputer: () -> Unit,
    onPair: () -> Unit,
    onForget: () -> Unit,
    onBack: () -> Unit,
) {
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        titleContentColor = MaterialTheme.colorScheme.onSurface,
                        navigationIconContentColor = MaterialTheme.colorScheme.primary,
                    ),
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    },
                    title = {
                        Text(
                            "Settings",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                        )
                    },
                )
                HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.border)
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            // DISPLAY SECTION
            item {
                SectionHeader("DISPLAY")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(end = 16.dp),
                            ) {
                                Text(
                                    "Keep screen awake",
                                    style = MaterialTheme.typography.bodyLarge,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    "Prevent the display from sleeping while Parallel Code is open.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = AppTheme.extra.textMuted,
                                )
                            }
                            Switch(
                                checked = keepScreenOn,
                                onCheckedChange = onKeepScreenOnChange,
                                colors = SwitchDefaults.colors(
                                    checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                                    checkedTrackColor = MaterialTheme.colorScheme.primary,
                                    uncheckedThumbColor = AppTheme.extra.textMuted,
                                    uncheckedTrackColor = AppTheme.extra.inputBg,
                                    uncheckedBorderColor = AppTheme.extra.border,
                                ),
                            )
                        }

                        AnimatedVisibility(
                            visible = keepScreenOn,
                            enter = expandVertically(animationSpec = tween(280, easing = FastOutSlowInEasing)) + fadeIn(tween(220)),
                            exit = shrinkVertically(animationSpec = tween(240, easing = FastOutSlowInEasing)) + fadeOut(tween(180)),
                        ) {
                            Column(
                                modifier = Modifier.fillMaxWidth(),
                                verticalArrangement = Arrangement.spacedBy(14.dp),
                            ) {
                                HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle)
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Column(
                                        modifier = Modifier
                                            .weight(1f)
                                            .padding(end = 16.dp),
                                    ) {
                                        Text(
                                            "Only while tasks are active",
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.Medium,
                                            color = MaterialTheme.colorScheme.onSurface,
                                        )
                                        Spacer(Modifier.height(2.dp))
                                        Text(
                                            "Allow screen to sleep when all agents finish or are idle.",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = AppTheme.extra.textMuted,
                                        )
                                    }
                                    Switch(
                                        checked = keepScreenOnOnlyActive,
                                        onCheckedChange = onKeepScreenOnOnlyActiveChange,
                                        colors = SwitchDefaults.colors(
                                            checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                                            checkedTrackColor = MaterialTheme.colorScheme.primary,
                                            uncheckedThumbColor = AppTheme.extra.textMuted,
                                            uncheckedTrackColor = AppTheme.extra.inputBg,
                                            uncheckedBorderColor = AppTheme.extra.border,
                                        ),
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // APPEARANCE SECTION
            item {
                SectionHeader("APPEARANCE")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    ) {
                        ThemeOptionRow(
                            title = "Follow system",
                            subtitle = "Match Android device theme settings",
                            selected = themeMode == SettingsStore.THEME_SYSTEM,
                            onClick = { onThemeModeChange(SettingsStore.THEME_SYSTEM) },
                        )
                        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle, modifier = Modifier.padding(horizontal = 8.dp))
                        ThemeOptionRow(
                            title = "Always dark",
                            subtitle = "Keep dark looks even when the phone is in light mode",
                            selected = themeMode == SettingsStore.THEME_DARK,
                            onClick = { onThemeModeChange(SettingsStore.THEME_DARK) },
                        )
                        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle, modifier = Modifier.padding(horizontal = 8.dp))
                        ThemeOptionRow(
                            title = "Always light",
                            subtitle = "Keep light looks even when the phone is in dark mode",
                            selected = themeMode == SettingsStore.THEME_LIGHT,
                            onClick = { onThemeModeChange(SettingsStore.THEME_LIGHT) },
                        )
                    }
                }
            }

            // Look presets, split by tone the way the desktop groups them. The
            // slot being edited is the tone the phone is actually in, so tapping
            // a swatch previews the look you are choosing.
            item {
                val systemDark = isSystemInDarkTheme()
                val editingDark = when (themeMode) {
                    SettingsStore.THEME_DARK -> true
                    SettingsStore.THEME_LIGHT -> false
                    else -> systemDark
                }
                val selectedId =
                    if (editingDark) darkThemePreset else lightThemePreset
                val onSelect: (String) -> Unit =
                    if (editingDark) onDarkThemePresetChange else onLightThemePresetChange
                val presets = if (editingDark) LookPresets.dark else LookPresets.light

                SectionHeader(if (editingDark) "DARK LOOKS" else "LIGHT LOOKS")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        presets.forEachIndexed { index, preset ->
                            if (index > 0) {
                                HorizontalDivider(
                                    thickness = 1.dp,
                                    color = AppTheme.extra.borderSubtle,
                                )
                            }
                            LookPresetRow(
                                preset = preset,
                                selected = preset.id == selectedId,
                                onClick = { onSelect(preset.id) },
                            )
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "The same looks as the desktop app. Follow system picks your " +
                        "dark or light set automatically.",
                    style = MaterialTheme.typography.bodySmall,
                    color = AppTheme.extra.textSubtle,
                )
            }

            // TASKS SECTION
            item {
                SectionHeader("TASKS")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        SettingSwitchRow(
                            title = "Show minimized tasks",
                            description = "Pin collapsed and minimized tasks to the bottom of the overview.",
                            checked = showMinimizedTasks,
                            onCheckedChange = onShowMinimizedTasksChange,
                        )
                    }
                }
            }

            // NOTIFICATIONS SECTION
            item {
                SectionHeader("NOTIFICATIONS")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        SettingSwitchRow(
                            title = "Notify me about agents",
                            description = "Keeps the connection open in the background, with a quiet ongoing notification. Uses some battery.",
                            checked = notifications.enabled,
                            onCheckedChange = { onNotificationsChange(notifications.copy(enabled = it)) },
                        )
                        AnimatedVisibility(
                            visible = notifications.enabled,
                            enter = expandVertically(animationSpec = tween(280, easing = FastOutSlowInEasing)) + fadeIn(tween(220)),
                            exit = shrinkVertically(animationSpec = tween(240, easing = FastOutSlowInEasing)) + fadeOut(tween(180)),
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                                HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle)
                                SettingSwitchRow(
                                    title = "Needs input",
                                    description = "An agent is waiting for an answer or approval.",
                                    checked = notifications.needsInput,
                                    onCheckedChange = { onNotificationsChange(notifications.copy(needsInput = it)) },
                                )
                                SettingSwitchRow(
                                    title = "Errors",
                                    description = "An agent stopped on an error.",
                                    checked = notifications.errors,
                                    onCheckedChange = { onNotificationsChange(notifications.copy(errors = it)) },
                                )
                                SettingSwitchRow(
                                    title = "Finished",
                                    description = "An agent finished working or exited.",
                                    checked = notifications.finished,
                                    onCheckedChange = { onNotificationsChange(notifications.copy(finished = it)) },
                                )
                            }
                        }
                    }
                }
            }

            // TERMINAL SECTION
            item {
                SectionHeader("TERMINAL")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        QuickRepliesEditor(quickReplies, onQuickRepliesChange)
                        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle, modifier = Modifier.padding(vertical = 14.dp))
                        SettingSwitchRow(
                            title = "Send quick replies immediately",
                            description = "Tapping a quick reply in a built-in chat sends it straight away. Off, it is added to your draft first.",
                            checked = sendQuickReplies,
                            onCheckedChange = onSendQuickRepliesChange,
                        )
                        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle, modifier = Modifier.padding(vertical = 14.dp))
                        SettingSwitchRow(
                            title = "Always scroll to latest output",
                            description = "Jump to new output even after scrolling up. Off, the terminal follows output only while you are at the bottom.",
                            checked = alwaysFollowOutput,
                            onCheckedChange = onAlwaysFollowOutputChange,
                        )
                        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle, modifier = Modifier.padding(vertical = 14.dp))
                        SettingSwitchRow(
                            title = "Fit the terminal to this phone",
                            description = "Full-screen agents such as Claude Code fill the phone while you view them. Your computer's terminal is redrawn for the phone meanwhile and shifts until you leave.",
                            checked = fitTerminalToPhone,
                            onCheckedChange = onFitTerminalToPhoneChange,
                        )
                    }
                }
            }

            // WIDGET SECTION
            item {
                SectionHeader("WIDGET")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "Background transparency",
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                "$widgetTransparency%",
                                style = MaterialTheme.typography.bodyLarge,
                                fontFamily = FontFamily.Monospace,
                                fontWeight = FontWeight.Medium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        Text(
                            "How much of your wallpaper shows through the home-screen widget. Its border fades with the card.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = AppTheme.extra.textMuted,
                        )
                        Slider(
                            value = widgetTransparency.toFloat(),
                            onValueChange = { onWidgetTransparencyChange(widgetTransparencyStep(it.roundToInt())) },
                            valueRange = WIDGET_TRANSPARENCY_STEPS.last().toFloat()..WIDGET_TRANSPARENCY_STEPS.first().toFloat(),
                            // The stops above are the only values, so the slider snaps between them.
                            steps = WIDGET_TRANSPARENCY_STEPS.size - 2,
                            colors = SliderDefaults.colors(
                                thumbColor = MaterialTheme.colorScheme.primary,
                                activeTrackColor = MaterialTheme.colorScheme.primary,
                                inactiveTrackColor = AppTheme.extra.inputBg,
                                inactiveTickColor = AppTheme.extra.border,
                                activeTickColor = MaterialTheme.colorScheme.onPrimary,
                            ),
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "${WIDGET_TRANSPARENCY_STEPS.last()}%",
                                style = MaterialTheme.typography.labelSmall,
                                color = AppTheme.extra.textMuted,
                            )
                            Text(
                                "${WIDGET_TRANSPARENCY_STEPS.first()}%",
                                style = MaterialTheme.typography.labelSmall,
                                color = AppTheme.extra.textMuted,
                            )
                        }

                        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle)

                        Text(
                            "Card color",
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            "The card's color. Its text colors follow so they stay readable.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = AppTheme.extra.textMuted,
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            WIDGET_PALETTES.forEach { palette ->
                                WidgetSwatch(
                                    palette = palette,
                                    transparency = widgetTransparency,
                                    selected = palette.key == widgetPalette,
                                    onClick = { onWidgetPaletteChange(palette.key) },
                                )
                            }
                        }
                    }
                }
            }

            // DESKTOP CONNECTION SECTION
            item {
                SectionHeader("DESKTOP CONNECTION")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        val host = state.link?.baseUrl ?: "Not connected"
                        val hostLabel = computers.firstOrNull { it.baseUrl == state.link?.baseUrl }?.label
                            ?: host.substringAfter("://")
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Computer", style = MaterialTheme.typography.bodyMedium, color = AppTheme.extra.textMuted)
                            Text(
                                hostLabel,
                                style = MaterialTheme.typography.bodyMedium,
                                fontFamily = FontFamily.Monospace,
                                fontWeight = FontWeight.Medium,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                        }

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Status", style = MaterialTheme.typography.bodyMedium, color = AppTheme.extra.textMuted)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                val statusColor = when (state.status) {
                                    ConnectionStatus.CONNECTED -> AppTheme.extra.success
                                    ConnectionStatus.WAITING_FOR_VPN -> AppTheme.extra.warningText
                                    else -> AppTheme.extra.textMuted
                                }
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(statusColor),
                                )
                                Text(
                                    statusLabel(state),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = statusColor,
                                )
                            }
                        }

                        if (state.status == ConnectionStatus.CONNECTED) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("Latency", style = MaterialTheme.typography.bodyMedium, color = AppTheme.extra.textMuted)
                                Text(
                                    latencyMs?.let { "${it} ms" } ?: "< 10 ms",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontFamily = FontFamily.Monospace,
                                    fontWeight = FontWeight.Medium,
                                    color = AppTheme.extra.textPrimary,
                                )
                            }
                        }

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Permissions", style = MaterialTheme.typography.bodyMedium, color = AppTheme.extra.textMuted)
                            Text(
                                if (state.canControl) "Full control (paired)" else "View only",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                                color = if (state.canControl) MaterialTheme.colorScheme.primary else AppTheme.extra.textMuted,
                            )
                        }

                        if (!state.canControl && state.status == ConnectionStatus.CONNECTED) {
                            Button(
                                onClick = onPair,
                                modifier = Modifier.fillMaxWidth(),
                                shape = MaterialTheme.shapes.small,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = MaterialTheme.colorScheme.primary,
                                    contentColor = MaterialTheme.colorScheme.onPrimary,
                                ),
                            ) {
                                Text("Pair with PIN to enable replies", fontWeight = FontWeight.SemiBold)
                            }
                        }

                        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle)

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(end = 16.dp),
                            ) {
                                Text(
                                    "Wait for VPN",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                Spacer(Modifier.height(2.dp))
                                Text(
                                    "Pause connection until a VPN (such as Tailscale or WireGuard) is active.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = AppTheme.extra.textMuted,
                                )
                            }
                            Switch(
                                checked = waitForVpn,
                                onCheckedChange = onWaitForVpnChange,
                                colors = SwitchDefaults.colors(
                                    checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                                    checkedTrackColor = MaterialTheme.colorScheme.primary,
                                    uncheckedThumbColor = AppTheme.extra.textMuted,
                                    uncheckedTrackColor = AppTheme.extra.inputBg,
                                    uncheckedBorderColor = AppTheme.extra.border,
                                ),
                            )
                        }

                        if (waitForVpn) {
                            HomeWifiEditor(
                                ssid = homeWifiSsid,
                                onChange = onHomeWifiSsidChange,
                                currentSsid = currentWifiSsid,
                                onUseCurrent = onUseCurrentWifi,
                            )
                        }

                        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.border)

                        OutlinedButton(
                            onClick = onForget,
                            modifier = Modifier.fillMaxWidth(),
                            shape = MaterialTheme.shapes.small,
                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.5f)),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        ) {
                            Text("Forget this computer", fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }

            // COMPUTERS SECTION
            item {
                SectionHeader("COMPUTERS")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp)) {
                        computers.forEach { computer ->
                            ComputerRow(
                                computer = computer,
                                inUse = computer.baseUrl == state.link?.baseUrl,
                                onSelect = { onSwitchComputer(computer.baseUrl) },
                                onRename = { onRenameComputer(computer.baseUrl, it) },
                                onForget = { onForgetComputer(computer.baseUrl) },
                            )
                            HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle, modifier = Modifier.padding(horizontal = 8.dp))
                        }
                        TextButton(onClick = onAddComputer, modifier = Modifier.fillMaxWidth()) {
                            Text("Add another computer", fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }

            // BACKUP SECTION
            item {
                SectionHeader("BACKUP")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Box(Modifier.fillMaxWidth().padding(16.dp)) { BackupSettings() }
                }
            }

            // ABOUT SECTION
            item {
                SectionHeader("ABOUT")
                Spacer(Modifier.height(8.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.large,
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, AppTheme.extra.border),
                ) {
                    Box(Modifier.fillMaxWidth().padding(16.dp)) { UpdateSettings() }
                }
            }
        }
    }
}

@Composable
private fun ThemeOptionRow(
    title: String,
    subtitle: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(
            selected = selected,
            onClick = null,
            colors = RadioButtonDefaults.colors(
                selectedColor = MaterialTheme.colorScheme.primary,
                unselectedColor = AppTheme.extra.textMuted,
            ),
        )
        Column(modifier = Modifier.padding(start = 10.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = AppTheme.extra.textMuted,
            )
        }
    }
}

/**
 * One look preset in the settings list, with a live swatch drawn from that
 * palette rather than from the active theme, so a swatch always shows the look it
 * stands for. The desktop's cards show only a name and description; a phone needs
 * the colors to tell fifteen looks apart.
 */
@Composable
private fun LookPresetRow(
    preset: LookPalette,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val extra = AppTheme.extra
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LookSwatch(preset = preset, selected = selected)
        Column(modifier = Modifier.padding(start = 12.dp).weight(1f)) {
            Text(
                preset.label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                preset.description,
                style = MaterialTheme.typography.bodySmall,
                color = extra.textMuted,
            )
        }
        if (selected) {
            Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 8.dp).size(18.dp),
            )
        }
    }
}

/**
 * A miniature of the preset: its window background, a panel, and the accent and
 * status dots. Radius comes from the preset too, so the square-edged looks read
 * as different from the rounded ones at a glance.
 */
@Composable
private fun LookSwatch(preset: LookPalette, selected: Boolean) {
    val borderColor =
        if (selected) {
            blendOver(AppTheme.extra.border, preset.accent, 0.72f)
        } else {
            AppTheme.extra.border
        }
    Box(
        modifier = Modifier
            .size(width = 52.dp, height = 40.dp)
            .clip(RoundedCornerShape(preset.radiusIsland.coerceAtLeast(2.dp)))
            .background(preset.bg)
            .border(1.dp, borderColor, RoundedCornerShape(preset.radiusIsland.coerceAtLeast(2.dp)))
            .padding(3.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(RoundedCornerShape(preset.radiusXs.coerceAtLeast(1.dp)))
                .background(preset.panelBg)
                .padding(3.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SwatchDot(preset.accent)
                Spacer(Modifier.width(2.dp))
                SwatchDot(preset.success)
                Spacer(Modifier.width(2.dp))
                SwatchDot(preset.warning)
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.SwatchDot(color: Color) {
    Box(
        modifier = Modifier
            .size(5.dp)
            .clip(CircleShape)
            .background(color),
    )
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.sp,
        color = AppTheme.extra.textMuted,
        modifier = Modifier.padding(start = 4.dp),
    )
}

@Composable
internal fun SettingSwitchRow(
    title: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(end = 16.dp),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                description,
                style = MaterialTheme.typography.bodyMedium,
                color = AppTheme.extra.textMuted,
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                checkedTrackColor = MaterialTheme.colorScheme.primary,
                uncheckedThumbColor = AppTheme.extra.textMuted,
                uncheckedTrackColor = AppTheme.extra.inputBg,
                uncheckedBorderColor = AppTheme.extra.border,
            ),
        )
    }
}

/** A card color to tap: a preview of the widget in that color at the chosen transparency. */
@Composable
private fun RowScope.WidgetSwatch(
    palette: WidgetPalette,
    transparency: Int,
    selected: Boolean,
    onClick: () -> Unit,
) {
    // The card drawables hold the same alpha steps, so mirror it here over the settings surface.
    val fill = Color(palette.fill).copy(alpha = widgetTransparencyStep(transparency) / 100f)
    Column(
        modifier = Modifier
            .weight(1f)
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.background)
                .background(fill)
                .border(
                    width = if (selected) 2.dp else 1.dp,
                    color = if (selected) MaterialTheme.colorScheme.primary else AppTheme.extra.border,
                    shape = RoundedCornerShape(8.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                palette.label,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                color = Color(palette.headline),
            )
        }
    }
}

/** The home Wi-Fi name; saved when the field loses focus or the screen closes. */
@Composable
private fun HomeWifiEditor(ssid: String?, onChange: (String?) -> Unit, currentSsid: String?, onUseCurrent: () -> Unit) {
    var text by remember(ssid) { mutableStateOf(ssid.orEmpty()) }
    val latest by rememberUpdatedState(text)
    DisposableEffect(Unit) { onDispose { if (latest.trim() != ssid.orEmpty()) onChange(latest) } }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "Home Wi-Fi",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            "On this Wi-Fi network, connect without waiting for the VPN. Android needs location access to read the network's name; allow it all the time so agent notifications connect here too.",
            style = MaterialTheme.typography.bodySmall,
            color = AppTheme.extra.textMuted,
        )
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier
                .fillMaxWidth()
                .onFocusChanged { if (!it.isFocused && text.trim() != ssid.orEmpty()) onChange(text) },
            placeholder = { Text("Wi-Fi name") },
            singleLine = true,
        )
        if (currentSsid == null || currentSsid != ssid) {
            TextButton(onClick = onUseCurrent) {
                Text(if (currentSsid != null) "Use current Wi-Fi ($currentSsid)" else "Use current Wi-Fi")
            }
        }
    }
}

/** One reply per line; saved when the field loses focus or the screen closes. */
@Composable
private fun QuickRepliesEditor(replies: List<String>, onChange: (List<String>) -> Unit) {
    var text by remember(replies) { mutableStateOf(replies.joinToString("\n")) }
    val latest by rememberUpdatedState(text)
    DisposableEffect(Unit) { onDispose { if (latest.lines() != replies) onChange(latest.lines()) } }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "Quick replies",
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            "Shown above the reply box in built-in chats; tap one to add it to your message. One per line.",
            style = MaterialTheme.typography.bodyMedium,
            color = AppTheme.extra.textMuted,
        )
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier
                .fillMaxWidth()
                .onFocusChanged { if (!it.isFocused) onChange(text.lines()) },
            minLines = 3,
            maxLines = 8,
        )
    }
}

/** A saved computer: tap to switch to it; the one in use is marked and cannot be forgotten here. */
@Composable
private fun ComputerRow(
    computer: SavedComputer,
    inUse: Boolean,
    onSelect: () -> Unit,
    onRename: (String?) -> Unit,
    onForget: () -> Unit,
) {
    var renaming by remember(computer.baseUrl) { mutableStateOf(false) }
    if (renaming) {
        RenameComputerDialog(
            computer = computer,
            onConfirm = {
                onRename(it)
                renaming = false
            },
            onDismiss = { renaming = false },
        )
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !inUse, onClick = onSelect)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = inUse, onClick = if (inUse) null else onSelect)
        Column(Modifier.weight(1f).padding(start = 4.dp)) {
            Text(
                computer.label,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (computer.alias?.isNotBlank() == true) {
                Text(
                    computer.baseUrl.substringAfter("://"),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    color = AppTheme.extra.textMuted,
                )
            }
            Text(
                (if (inUse) "In use · " else "") + if (computer.pairedToken != null) "Paired" else "View only",
                style = MaterialTheme.typography.bodySmall,
                color = AppTheme.extra.textMuted,
            )
        }
        TextButton(onClick = { renaming = true }) { Text("Label") }
        if (!inUse) {
            TextButton(onClick = onForget) { Text("Forget", color = MaterialTheme.colorScheme.error) }
        }
    }
}

/** Name a saved computer so it reads as something friendlier than its address. */
@Composable
private fun RenameComputerDialog(
    computer: SavedComputer,
    onConfirm: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var text by remember(computer.baseUrl) { mutableStateOf(computer.alias.orEmpty()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
        title = { Text("Label this computer") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Shown in the header, the switch menu and this list instead of the address.",
                    color = AppTheme.extra.textMuted,
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Label (optional)") },
                    placeholder = { Text(computer.baseUrl.substringAfter("://")) },
                    singleLine = true,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(text.takeIf { it.isNotBlank() }) }) {
                Text("Save", fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

