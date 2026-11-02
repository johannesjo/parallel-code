package com.parallelcode.phone

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Star
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Saved replies from Settings: tapping one puts it in the draft, ready to send or edit. */
@Composable
fun QuickReplies(replies: List<String>, enabled: Boolean, onPick: (String) -> Unit) {
    if (replies.isEmpty()) return
    val haptic = LocalHapticFeedback.current
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        replies.forEach { reply ->
            AssistChip(
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    onPick(reply)
                },
                enabled = enabled,
                label = { Text(reply, maxLines = 1) },
            )
        }
    }
}

/**
 * The same saved replies behind one button, for a reply box with no row to spare: tapping the
 * button lists them, and picking one hands it to [onPick]. Hidden when there are none. [modifier]
 * applies to the button itself.
 */
@Composable
fun QuickRepliesButton(
    replies: List<String>,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onPick: (String) -> Unit,
) {
    if (replies.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    val haptic = LocalHapticFeedback.current
    Box {
        IconButton(onClick = { open = true }, enabled = enabled, modifier = modifier) {
            Icon(Icons.Filled.Star, contentDescription = "Quick replies")
        }
        DropdownMenu(expanded = open && enabled, onDismissRequest = { open = false }) {
            replies.forEach { reply ->
                DropdownMenuItem(
                    text = { Text(reply, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    onClick = {
                        // The closing menu still takes taps while it animates out: pick only once.
                        if (!open) return@DropdownMenuItem
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        open = false
                        onPick(reply)
                    },
                )
            }
        }
    }
}

/** Adds [text] to a draft, as typing it after what is already there would. */
fun appendToDraft(draft: String, text: String): String = when {
    draft.isBlank() -> text
    draft.endsWith(" ") || draft.endsWith("\n") -> draft + text
    else -> "$draft $text"
}

/** Messages this agent was sent before, newest first: picking one puts it back in the draft. */
@Composable
fun PromptHistoryDialog(
    history: List<String>,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
        title = { Text("Recent messages") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                history.forEach { message ->
                    Text(
                        message,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(message) }
                            .padding(horizontal = 4.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        },
    )
}

/**
 * Dictate into the draft with Android's speech recognizer. Hidden when the phone has none; the
 * recognizer shows its own listening UI, so the app needs no microphone permission.
 */
@Composable
fun VoiceInputButton(enabled: Boolean, modifier: Modifier = Modifier, onText: (String) -> Unit) {
    if (LocalDemoMode.current) {
        IconButton(onClick = { onText("Demo dictation: review the sample changes") }, enabled = enabled, modifier = modifier) {
            Icon(Icons.Filled.Mic, contentDescription = "Simulate dictation (no microphone)")
        }
        return
    }
    val context = LocalContext.current
    val intent = remember {
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak your reply")
    }
    val available = remember { intent.resolveActivity(context.packageManager) != null }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let(onText)
    }
    if (!available) return
    IconButton(onClick = { launcher.launch(intent) }, enabled = enabled, modifier = modifier) {
        Icon(Icons.Filled.Mic, contentDescription = "Dictate a reply")
    }
}

/** Opens the agent's recent messages. Disabled rather than hidden while there are none, so the field doesn't shift. */
@Composable
fun PromptHistoryButton(enabled: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled) {
        Icon(Icons.Filled.History, contentDescription = "Recent messages")
    }
}

/**
 * The reply box's one main action beside the field: Stop while the agent works and the draft is
 * empty, otherwise Send.
 */
@Composable
fun ComposerSendButton(
    stop: Boolean,
    enabled: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (stop) {
        OutlinedIconButton(onClick = onStop, enabled = enabled, modifier = modifier) {
            Icon(Icons.Filled.Stop, contentDescription = "Stop")
        }
        return
    }
    val haptic = LocalHapticFeedback.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.94f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label = "sendButtonScale",
    )
    FilledIconButton(
        onClick = {
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            onSend()
        },
        enabled = enabled,
        interactionSource = interaction,
        modifier = modifier.graphicsLayer {
            scaleX = scale
            scaleY = scale
        },
    ) {
        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
    }
}
