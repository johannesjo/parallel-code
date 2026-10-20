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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Fix CI from the phone: loads the desktop's failed-checks prompt into an editable field. The log
 * tails come from GitHub and are untrusted, so the user reads (and may edit) them before anything
 * reaches the agent, as the desktop stages the same prompt instead of sending it.
 */
@Composable
internal fun FixCiDialog(
    taskId: String,
    client: RemoteClient,
    onDismiss: () -> Unit,
    onSent: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var prompt by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var nothingFailed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(taskId) {
        try {
            val loaded = client.fetchFixCiPrompt(taskId)
            if (loaded == null) nothingFailed = true else prompt = loaded.take(MAX_FIX_CI_PROMPT_LENGTH)
        } catch (e: ApiException) {
            // Older desktops refuse unknown paired-token paths with 403, as fetchAgentChoices notes.
            error =
                if (e.status == 403 || e.status == 404) {
                    "Update Parallel Code on your computer to fix CI here."
                } else {
                    e.message
                }
        } finally {
            loading = false
        }
    }

    fun send() {
        busy = true
        error = null
        scope.launch {
            try {
                client.sendFixCiPrompt(taskId, prompt)
                onSent()
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
        title = { Text("Fix CI") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when {
                    loading -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                    nothingFailed -> Text("No failed checks found.")
                    error == null || prompt.isNotEmpty() -> {
                        Text(
                            "Check logs come from GitHub. Review them before the agent sees them.",
                            style = MaterialTheme.typography.bodySmall,
                            color = AppTheme.extra.textMuted,
                        )
                        OutlinedTextField(
                            value = prompt,
                            onValueChange = { prompt = it.take(MAX_FIX_CI_PROMPT_LENGTH) },
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 360.dp),
                            textStyle = MaterialTheme.typography.bodySmall,
                        )
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
            if (!loading && !nothingFailed && prompt.isNotEmpty()) {
                TextButton(onClick = ::send, enabled = !busy && prompt.isNotBlank()) {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Text("Send to agent", fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) {
                Text(if (nothingFailed) "Close" else "Cancel")
            }
        },
    )
}
