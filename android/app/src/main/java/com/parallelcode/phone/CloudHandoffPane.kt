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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * "Continue in cloud" from the phone, as the desktop dialog runs it: the desktop's default prompt
 * in an editable field and the same push-first option. The desktop pushes, then runs the cloud
 * session in a terminal of the task that this app cannot show, so it says where to follow it.
 */
@Composable
internal fun CloudHandoffDialog(taskId: String, client: PhoneClient, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var handoff by remember { mutableStateOf<CloudHandoff?>(null) }
    // Saved across rotation: a reset `started` would offer Start again and launch a second session.
    var prompt by rememberSaveable { mutableStateOf("") }
    var push by rememberSaveable { mutableStateOf(true) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var started by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(taskId) {
        try {
            val loaded = client.fetchCloudHandoff(taskId)
            handoff = loaded
            if (prompt.isEmpty()) prompt = loaded.prompt
        } catch (e: ApiException) {
            // Older desktops refuse unknown paired-token paths with 403, as fetchAgentChoices notes.
            error =
                if (e.status == 403 || e.status == 404) {
                    "Update Parallel Code on your computer to continue in the cloud from here."
                } else {
                    e.message
                }
        } finally {
            loading = false
        }
    }

    val ready = handoff?.takeIf { it.available && !started }

    fun start() {
        val info = ready ?: return
        busy = true
        error = null
        scope.launch {
            try {
                client.startCloudHandoff(taskId, prompt, info.canPush && push)
                started = true
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
        title = { Text("Continue in cloud") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val current = handoff
                when {
                    loading -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                    started -> Text(
                        "The cloud session is starting on your computer. Follow it in the Claude app " +
                            "or on claude.ai/code. The local agent keeps running.",
                    )
                    current != null && !current.available -> Text(current.reason)
                    current != null -> {
                        Text(
                            "Starts a Claude Code session on claude.ai from ${current.branchName}. When it " +
                                "clones from GitHub, only pushed commits reach it. Without a remote or the " +
                                "Claude GitHub App, Claude Code uploads the local repository instead, including " +
                                "uncommitted changes to tracked files. The local agent keeps running.",
                            style = MaterialTheme.typography.bodySmall,
                            color = AppTheme.extra.textMuted,
                        )
                        OutlinedTextField(
                            value = prompt,
                            onValueChange = { prompt = it.take(MAX_CLOUD_PROMPT_LENGTH) },
                            enabled = !busy,
                            label = { Text("Prompt for the cloud session") },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 280.dp),
                            textStyle = MaterialTheme.typography.bodySmall,
                        )
                        if (current.canPush) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(checked = push, onCheckedChange = { push = it }, enabled = !busy)
                                Text("Push ${current.branchName} to origin first")
                            }
                        }
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
            if (ready != null) {
                TextButton(onClick = ::start, enabled = !busy && prompt.isNotBlank()) {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Text("Start cloud session", fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) {
                Text(if (ready != null) "Cancel" else "Close")
            }
        },
    )
}
