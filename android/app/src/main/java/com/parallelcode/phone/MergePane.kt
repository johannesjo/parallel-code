package com.parallelcode.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** The desktop's readiness verdicts, as its merge panel words them. */
private fun overallTitle(overall: String): String = when (overall) {
    "ready" -> "Ready to merge"
    "attention" -> "Needs attention"
    "blocked" -> "Not ready to merge"
    else -> "Checking"
}

@Composable
private fun statusColor(status: String) = when (status) {
    "pass" -> AppTheme.extra.success
    "blocked" -> MaterialTheme.colorScheme.error
    "warning", "checking" -> AppTheme.extra.warningText
    else -> AppTheme.extra.textMuted
}

private fun statusSymbol(status: String): String = when (status) {
    "pass" -> "✓"
    "blocked" -> "×"
    "warning" -> "!"
    "checking" -> "…"
    else -> "—"
}

/**
 * Merge a task from the phone.
 *
 * The readiness checks are the desktop's own, read-only and advisory — opening this
 * dialog never runs verification or tests. A blocked verdict disables the confirm
 * button; a warning does not, so someone away from their desk can still merge with
 * eyes open. Mirrors the phone web UI's dialog in src/remote/TaskActionsDialog.tsx.
 */
@Composable
internal fun MergeTaskDialog(
    taskId: String,
    client: RemoteClient,
    onDismiss: () -> Unit,
    onMerged: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var readiness by remember { mutableStateOf<MergeReadiness?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var squash by remember { mutableStateOf(false) }
    var cleanup by remember { mutableStateOf(false) }

    var loadAttempt by remember { mutableIntStateOf(0) }

    LaunchedEffect(taskId, loadAttempt) {
        loading = true
        error = null
        try {
            readiness = client.fetchMergeReadiness(taskId)
        } catch (e: ApiException) {
            error =
                if (e.status == 403 || e.status == 404) {
                    "Update Parallel Code on your computer to merge here."
                } else {
                    e.message
                }
        } finally {
            loading = false
        }
    }

    fun submit() {
        busy = true
        error = null
        scope.launch {
            try {
                client.mergeTask(taskId, squash, cleanup)
                onMerged()
            } catch (e: ApiException) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
        title = {
            Text(readiness?.let { "Merge into ${it.baseBranch}" } ?: "Merge task")
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (loading && readiness == null) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                }
                val current = readiness
                if (current != null) {
                    Text(
                        overallTitle(current.overall),
                        color = statusColor(if (current.overall == "ready") "pass" else "warning"),
                        fontWeight = FontWeight.SemiBold,
                    )
                    current.checks.forEach { check ->
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                statusSymbol(check.status),
                                color = statusColor(check.status),
                                fontWeight = FontWeight.SemiBold,
                            )
                            Column {
                                Text(check.label, fontWeight = FontWeight.SemiBold)
                                Text(
                                    check.detail,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = AppTheme.extra.textMuted,
                                )
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = squash, onCheckedChange = { squash = it })
                        Text("Squash into one commit")
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = cleanup, onCheckedChange = { cleanup = it })
                        Text("Close the task and remove its worktree afterwards")
                    }
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
                onClick = ::submit,
                // A blocker must be resolved on the computer first; a warning must not.
                enabled = !busy && readiness?.canMerge == true,
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text("Merge", fontWeight = FontWeight.SemiBold)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") }
        },
    )
}
