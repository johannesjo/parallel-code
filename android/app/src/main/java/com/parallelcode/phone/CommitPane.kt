package com.parallelcode.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

private enum class CommitBusy { STAGING, UNSTAGING, COMMITTING }

/**
 * Commit a task's work from the phone, like the desktop's commit dialog
 * (src/components/CommitDialog.tsx): list the uncommitted files and which are staged, stage or
 * unstage everything, and commit what is staged. Nothing is staged until asked, so a commit holds
 * exactly what the list shows as staged.
 */
@Composable
internal fun CommitTaskDialog(
    taskId: String,
    client: RemoteClient,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<CommitStatus?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf<CommitBusy?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf("") }

    LaunchedEffect(taskId) {
        loading = true
        error = null
        try {
            status = client.fetchCommitStatus(taskId)
        } catch (e: ApiException) {
            error =
                if (e.status == 403 || e.status == 404) {
                    "Update Parallel Code on your computer to commit here."
                } else {
                    e.message
                }
        } finally {
            loading = false
        }
    }

    fun run(kind: CommitBusy, action: suspend () -> CommitStatus, after: () -> Unit = {}) {
        busy = kind
        error = null
        scope.launch {
            try {
                status = action()
                after()
            } catch (e: ApiException) {
                error = e.message
                // The failed step may still have changed the index; show what is there now.
                runCatching { client.fetchCommitStatus(taskId) }.onSuccess { status = it }
            } finally {
                busy = null
            }
        }
    }

    val current = status
    val idle = busy == null

    AlertDialog(
        onDismissRequest = { if (idle) onDismiss() },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
        title = { Text("Commit changes") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (loading && current == null) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                }
                if (current != null && current.unsupported) {
                    Text("Only worktree tasks can be committed.", color = AppTheme.extra.textMuted)
                } else if (current != null) {
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${current.stagedCount} staged, ${current.unstagedCount} not staged",
                            style = MaterialTheme.typography.bodySmall,
                            color = AppTheme.extra.textMuted,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(
                            onClick = { run(CommitBusy.UNSTAGING, { client.unstageAll(taskId) }) },
                            enabled = idle && current.stagedCount > 0,
                        ) {
                            Text(if (busy == CommitBusy.UNSTAGING) "Unstaging…" else "Unstage all")
                        }
                        TextButton(
                            onClick = { run(CommitBusy.STAGING, { client.stageAll(taskId) }) },
                            enabled = idle && current.unstagedCount > 0,
                        ) {
                            Text(if (busy == CommitBusy.STAGING) "Staging…" else "Stage all")
                        }
                    }
                    if (current.files.isEmpty()) {
                        Text("No uncommitted changes.", color = AppTheme.extra.textMuted)
                    } else {
                        LazyColumn(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(max = 200.dp)
                                .background(MaterialTheme.colorScheme.background)
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            items(current.files, key = { it.path }) { file -> CommitFileRow(file) }
                        }
                    }
                    OutlinedTextField(
                        value = message,
                        onValueChange = { message = it },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = idle,
                        placeholder = { Text("Commit message…") },
                        minLines = 3,
                        maxLines = 6,
                        shape = MaterialTheme.shapes.large,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = AppTheme.extra.inputBg,
                            unfocusedContainerColor = AppTheme.extra.inputBg,
                            focusedBorderColor = MaterialTheme.colorScheme.primary,
                            unfocusedBorderColor = AppTheme.extra.border,
                        ),
                    )
                }
                error?.let {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .background(AppTheme.extra.warningBannerBg)
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                    ) {
                        Text(it, color = AppTheme.extra.warningText)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    run(CommitBusy.COMMITTING, { client.commitStaged(taskId, message.trim()) }, onDismiss)
                },
                enabled = idle && current != null && !current.unsupported &&
                    current.stagedCount > 0 && message.isNotBlank(),
            ) {
                if (busy == CommitBusy.COMMITTING) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text("Commit", fontWeight = FontWeight.SemiBold)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = idle) { Text("Cancel") }
        },
    )
}

@Composable
private fun CommitFileRow(file: CommitFile) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            if (file.staged) "✓" else "·",
            color = if (file.staged) AppTheme.extra.success else AppTheme.extra.textMuted,
            fontWeight = FontWeight.SemiBold,
        )
        Text(file.status, fontFamily = FontFamily.Monospace, color = AppTheme.extra.textMuted)
        Text(
            file.path,
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodySmall,
            color = if (file.staged) MaterialTheme.colorScheme.onSurface else AppTheme.extra.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
