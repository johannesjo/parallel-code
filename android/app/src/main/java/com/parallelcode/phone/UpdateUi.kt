package com.parallelcode.phone

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.text.format.DateUtils
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import kotlinx.coroutines.launch
import java.io.IOException

private fun Context.appUpdates(): AppUpdates = (applicationContext as PhoneApplication).updates

/** Opens a link in the browser, which also handles APK downloads. False when nothing can open it. */
internal fun Context.openLink(url: String): Boolean = try {
    startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
} catch (_: ActivityNotFoundException) {
    false
}

/** The version row and update controls in Settings › About. */
@Composable
fun UpdateSettings(demoSettings: DemoSettings? = null) {
    if (demoSettings != null) {
        DemoUpdateSettings(demoSettings)
        return
    }
    val context = LocalContext.current
    val updates = remember { context.appUpdates() }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Parallel Code", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
            Text("v${updates.currentVersion}", color = AppTheme.extra.textMuted, fontFamily = AppFonts.mono)
        }
        Text(
            "Mobile companion for monitoring and interacting with parallel AI agents.",
            style = MaterialTheme.typography.bodySmall,
            color = AppTheme.extra.textMuted,
        )
        PrivacyPolicyButton()
        if (updates.storeManaged) {
            Text(
                "Updates come from the app store this was installed from.",
                style = MaterialTheme.typography.bodySmall,
                color = AppTheme.extra.textMuted,
            )
        } else {
            UpdateControls(updates)
        }
    }
}

@Composable
private fun DemoUpdateSettings(demo: DemoSettings) {
    val context = LocalContext.current
    val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "unknown" }
    var enabled by remember { mutableStateOf(demo.checkUpdates) }
    var checked by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Parallel Code", fontWeight = FontWeight.SemiBold)
            Text("v$version", color = AppTheme.extra.textMuted, fontFamily = AppFonts.mono)
        }
        Text("Mobile companion for monitoring and interacting with parallel AI agents.", style = MaterialTheme.typography.bodySmall, color = AppTheme.extra.textMuted)
        PrivacyPolicyButton()
        Text("Offline demo · update checks and downloads are simulated. No network requests or browser opens.", style = MaterialTheme.typography.bodySmall, color = AppTheme.extra.textMuted)
        SettingSwitchRow(
            title = "Check for updates",
            description = "Preview the automatic update setting in this demo session.",
            checked = enabled,
            onCheckedChange = { enabled = it; demo.checkUpdates = it },
        )
        if (checked) {
            Text("Sample update available (simulated).", style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = { message = "Demo download preview. In a live session this opens the release download in your browser." }) { Text("Download") }
        }
        OutlinedButton(onClick = { checked = true; message = "Simulated update check complete." }) { Text("Check now") }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = AppTheme.extra.textMuted) }
    }
}

@Composable
private fun UpdateControls(updates: AppUpdates) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val available by updates.available.collectAsState()
    var enabled by remember { mutableStateOf(updates.enabled) }
    var checking by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SettingSwitchRow(
            title = "Check for updates",
            description = "Once a day, ask GitHub whether a newer version of this app was released",
            checked = enabled,
            onCheckedChange = {
                updates.enabled = it
                enabled = it
            },
        )
        available?.let { release ->
            Text(
                "Version ${release.version} is available.",
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium,
            )
            Button(onClick = { if (!context.openLink(release.downloadUrl)) message = "No browser to open the download." }) {
                Text("Download")
            }
        }
        OutlinedButton(
            enabled = !checking,
            onClick = {
                checking = true
                message = null
                scope.launch {
                    message = try {
                        if (updates.check() == null) "This is the newest version." else null
                    } catch (e: IOException) {
                        "Couldn't check for updates: ${e.message ?: "network error"}"
                    } finally {
                        checking = false
                    }
                }
            },
        ) { Text(if (checking) "Checking…" else "Check now") }
        val checkedAt = updates.checkedAt
        val note = message ?: if (checkedAt > 0) {
            "Last checked ${DateUtils.getRelativeTimeSpanString(checkedAt)}."
        } else {
            null
        }
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = AppTheme.extra.textMuted) }
    }
}

/** Agent list banner for a newer release, until the user updates or puts it off. */
@Composable
internal fun UpdateBanner() {
    val context = LocalContext.current
    val updates = remember { context.appUpdates() }
    val available by updates.available.collectAsState()
    val dismissed by updates.dismissedVersion.collectAsState()
    val release = available?.takeIf { it.version != dismissed } ?: return
    Card(
        modifier = Modifier.padding(horizontal = 16.dp),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, AppTheme.extra.border),
    ) {
        Row(
            Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Version ${release.version} is available.",
                Modifier.weight(1f),
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(onClick = { updates.dismiss(release) }) { Text("Later") }
            Button(
                onClick = { context.openLink(release.downloadUrl) },
                shape = MaterialTheme.shapes.small,
            ) { Text("Download", fontWeight = FontWeight.Bold) }
        }
    }
}
