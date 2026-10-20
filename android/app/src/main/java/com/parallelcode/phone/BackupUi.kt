package com.parallelcode.phone

import android.net.Uri
import android.provider.DocumentsContract
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val NO_PASSWORD_WARNING =
    "Without a password, the backup leaves out pairing, so you enter each computer's PIN again after restoring. " +
        "Anyone who gets the file can still watch your agents."

/**
 * Settings card: save a backup now, restore one, and back up automatically into a folder.
 * Lives inside a settings card, so it draws rows, not a card of its own.
 */
@Composable
fun BackupSettings() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val schedule = remember { BackupSchedule(context.applicationContext) }
    // Bumped after each change so the rows re-read the schedule.
    var revision by remember { mutableIntStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var askBackupPassword by remember { mutableStateOf(false) }
    var pendingPassword by remember { mutableStateOf<String?>(null) }
    var pickedFolder by remember { mutableStateOf<Uri?>(null) }

    fun save(uri: Uri?) {
        val password = pendingPassword
        pendingPassword = null
        if (uri == null) return
        busy = true
        scope.launch {
            message = withContext(Dispatchers.IO) {
                runCatching {
                    val bytes = Backup.create(backupStores(context), password)
                    context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("no stream")
                }.fold({ "Backup saved." }, { "Couldn't save the backup. Try another location." })
            }
            busy = false
        }
    }
    val savePlain = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(backupMimeType(false)), ::save)
    val saveEncrypted = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(backupMimeType(true)), ::save)
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { pickedFolder = it }

    fun backUpToFolderNow() {
        busy = true
        scope.launch {
            withContext(Dispatchers.IO) { schedule.backUpNow() }
            revision++
            busy = false
        }
    }

    if (askBackupPassword) {
        BackupPasswordDialog(
            title = "Back up this phone",
            confirmLabel = "Choose where to save",
            onDismiss = { askBackupPassword = false },
            onConfirm = { password ->
                askBackupPassword = false
                pendingPassword = password
                if (password == null) savePlain.launch(backupFileName(false)) else saveEncrypted.launch(backupFileName(true))
            },
        )
    }
    pickedFolder?.let { folder ->
        // Required here: the files pile up in a folder that is often synced off the phone.
        BackupPasswordDialog(
            title = "Back up automatically",
            confirmLabel = "Turn on",
            passwordRequired = true,
            onDismiss = { pickedFolder = null },
            onConfirm = { password ->
                pickedFolder = null
                val enabled = runCatching { schedule.enable(folder, schedule.intervalDays, password) }.isSuccess
                if (enabled) backUpToFolderNow() else message = "Couldn't use that folder. Pick another."
                revision++
            },
        )
    }

    // Read through `revision` so the rows follow every change made above.
    val folder = remember(revision) { schedule.folder }
    val intervalDays = remember(revision) { schedule.intervalDays }
    val lastBackupAt = remember(revision) { schedule.lastBackupAt }
    val lastError = remember(revision) { schedule.lastError }
    val encrypted = remember(revision) { schedule.hasPassword }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            "Save your computers, settings and sent-message history to a file, optionally encrypted with a password.",
            style = MaterialTheme.typography.bodyMedium,
            color = AppTheme.extra.textMuted,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { message = null; askBackupPassword = true }, enabled = !busy, modifier = Modifier.weight(1f)) {
                Text("Back up", fontWeight = FontWeight.SemiBold)
            }
            RestoreBackupButton(modifier = Modifier.weight(1f))
        }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = AppTheme.extra.textMuted) }

        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.border)

        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(end = 16.dp)) {
                Text("Back up automatically", style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                Text(
                    "Save a backup to a folder on a schedule, keeping the latest ${BackupSchedule.KEEP}.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AppTheme.extra.textMuted,
                )
            }
            Switch(
                checked = folder != null,
                enabled = !busy,
                onCheckedChange = { on ->
                    message = null
                    if (on) {
                        pickFolder.launch(null)
                    } else {
                        schedule.disable()
                        revision++
                    }
                },
            )
        }
        if (folder != null) {
            Text(
                "Folder: ${folderLabel(folder)}" + if (encrypted) " · encrypted" else " · no password, pairing left out",
                style = MaterialTheme.typography.bodySmall,
                color = AppTheme.extra.textMuted,
            )
            listOf(1 to "Daily", 7 to "Weekly").forEach { (days, label) ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable {
                            schedule.setIntervalDays(days)
                            revision++
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = intervalDays == days, onClick = null)
                    Text(label, modifier = Modifier.padding(start = 10.dp))
                }
            }
            Text(
                lastError ?: if (lastBackupAt > 0) {
                    "Last backup " + DateUtils.getRelativeTimeSpanString(lastBackupAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
                } else {
                    "No backup yet."
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (lastError != null) MaterialTheme.colorScheme.error else AppTheme.extra.textMuted,
            )
            TextButton(onClick = ::backUpToFolderNow, enabled = !busy) {
                Text("Back up to folder now", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/**
 * Restore from a backup file: confirm, pick the file, ask its password when it has one, then
 * restart so every screen and the connection read the restored data.
 */
@Composable
fun RestoreBackupButton(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirming by remember { mutableStateOf(false) }
    var encryptedFile by remember { mutableStateOf<ByteArray?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun restore(bytes: ByteArray, password: String?) {
        busy = true
        scope.launch {
            val failure = withContext(Dispatchers.IO) {
                runCatching { Backup.restore(bytes, password, backupStores(context)) }.exceptionOrNull()
            }
            busy = false
            if (failure == null) {
                restartApp(context)
            } else if (failure is BackupException && failure.message == Backup.WRONG_PASSWORD && password != null) {
                encryptedFile = bytes
                error = failure.message
            } else {
                error = (failure as? BackupException)?.message ?: "Couldn't restore that backup."
            }
        }
    }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        busy = true
        scope.launch {
            val bytes = withContext(Dispatchers.IO) {
                runCatching { context.contentResolver.openInputStream(uri)?.use(Backup::read) }.getOrNull()
            }
            busy = false
            when {
                bytes == null -> error = "Couldn't read that file."
                Backup.isEncrypted(bytes) -> encryptedFile = bytes
                else -> restore(bytes, null)
            }
        }
    }

    OutlinedButton(onClick = { error = null; confirming = true }, enabled = !busy, modifier = modifier) {
        Text(if (busy) "Restoring…" else "Restore", fontWeight = FontWeight.SemiBold)
    }
    error?.takeIf { encryptedFile == null }?.let {
        AlertDialog(
            onDismissRequest = { error = null },
            title = { Text("Restore failed") },
            text = { Text(it) },
            confirmButton = { TextButton(onClick = { error = null }) { Text("OK") } },
        )
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Restore from a backup?") },
            text = { Text("Computers, settings and message history on this phone are replaced with the backup's. The app restarts afterwards.") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    pickFile.launch(arrayOf("*/*"))
                }) { Text("Choose backup") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } },
        )
    }
    encryptedFile?.let { bytes ->
        var password by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { if (!busy) { encryptedFile = null; error = null } },
            title = { Text("Backup password") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PasswordField(password, { password = it }, "Password")
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                TextButton(enabled = password.isNotEmpty() && !busy, onClick = {
                    encryptedFile = null
                    error = null
                    restore(bytes, password)
                }) { Text(if (busy) "Restoring…" else "Restore") }
            },
            dismissButton = {
                TextButton(enabled = !busy, onClick = { encryptedFile = null; error = null }) { Text("Cancel") }
            },
        )
    }
}

/** Asks for a backup password, typed twice; unless [passwordRequired], [onConfirm] gets null for none. */
@Composable
private fun BackupPasswordDialog(
    title: String,
    confirmLabel: String,
    onDismiss: () -> Unit,
    onConfirm: (String?) -> Unit,
    passwordRequired: Boolean = false,
) {
    var password by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    val mismatch = repeat.isNotEmpty() && repeat != password
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PasswordField(password, { password = it }, if (passwordRequired) "Password" else "Password (optional)")
                if (password.isNotEmpty()) PasswordField(repeat, { repeat = it }, "Repeat password")
                Text(
                    when {
                        mismatch -> "The passwords don't match."
                        password.isEmpty() && passwordRequired -> "Automatic backups are always encrypted."
                        password.isEmpty() -> NO_PASSWORD_WARNING
                        else -> "Keep the password safe: a backup can't be restored without it."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (mismatch || (password.isEmpty() && !passwordRequired)) MaterialTheme.colorScheme.error else AppTheme.extra.textMuted,
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = if (password.isEmpty()) !passwordRequired else repeat == password,
                onClick = { onConfirm(password.ifEmpty { null }) },
            ) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun PasswordField(value: String, onChange: (String) -> Unit, label: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth(),
    )
}

/** "Documents/Backups" for a picked folder, from its tree document id ("primary:Documents/Backups"). */
private fun folderLabel(folder: Uri): String =
    runCatching { DocumentsContract.getTreeDocumentId(folder).substringAfter(':').ifEmpty { "Storage root" } }
        .getOrDefault(folder.toString())
