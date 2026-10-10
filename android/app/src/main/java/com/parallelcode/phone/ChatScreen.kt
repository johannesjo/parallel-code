package com.parallelcode.phone

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.FastOutSlowInEasing
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Tool output past this is cut on the phone; the desktop shows all of it. */
private const val MAX_TOOL_OUTPUT = 4000

/** A task whose agent runs in the desktop's built-in chat, as in the phone web UI's ChatDetail. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    agent: RemoteAgent?,
    agentId: String,
    state: ConnectionState,
    client: RemoteClient,
    quickReplies: List<String>,
    sendQuickReplies: Boolean = false,
    promptHistory: PromptHistoryStore? = null,
    pageLabel: String? = null,
    onBack: () -> Unit,
    onPair: () -> Unit,
) {
    val chatFlow = remember(agentId) { client.watchChat(agentId) }
    DisposableEffect(agentId) { onDispose { client.unwatchChat(agentId) } }
    val chat by chatFlow.collectAsState()
    var closing by remember { mutableStateOf(false) }
    val agentName = agent?.agentName ?: "The agent"
    val canSend = state.canControl && state.status == ConnectionStatus.CONNECTED

    if (closing && agent != null) {
        CloseTaskDialog(
            taskName = agent.taskName,
            close = { force -> client.closeTask(agent.taskId, force) },
            onDismiss = { closing = false },
            onClosed = {
                closing = false
                onBack()
            },
        )
    }

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
                        Column {
                            Text(
                                agent?.taskName ?: "Chat",
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                (chat?.let { chatStatusLabel(it) } ?: statusLabel(state)) + (pageLabel?.let { " · $it" } ?: ""),
                                style = MaterialTheme.typography.bodySmall,
                                color = AppTheme.extra.textMuted,
                            )
                        }
                    },
                    actions = {
                        if (agent != null && state.canControl) {
                            TextButton(onClick = { closing = true }) {
                                Text("Close", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    },
                )
                HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.border)
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
        ) {
            val current = chat
            if (current?.status == "closed") {
                Banner("This chat has stopped. Reconnect it on your computer to continue.")
            }
            current?.error?.let { Banner(it, error = true) }
            if (current == null) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text("Loading the conversation…", color = AppTheme.extra.textMuted)
                }
            } else {
                ChatTranscript(
                    chat = current,
                    agentName = agentName,
                    canRespond = canSend,
                    respond = { request, decision, answers ->
                        val params = JSONObject()
                            .put("requestId", request.id)
                            .put("decision", decision)
                            .put("answers", JSONObject(answers))
                        client.sendChatAction(agentId, "respond", params)
                    },
                    modifier = Modifier.weight(1f),
                )
            }
            if (!state.canControl) {
                Spacer(Modifier.height(8.dp))
                PairBanner(onPair)
                Spacer(Modifier.height(8.dp))
            } else {
                ChatComposer(
                    draftKey = agentId,
                    quickReplies = quickReplies,
                    sendQuickReplies = sendQuickReplies,
                    promptHistory = promptHistory,
                    enabled = canSend && current != null && current.status != "closed",
                    working = current?.status == "working",
                    send = { text -> client.sendChatAction(agentId, "send", JSONObject().put("text", text)) },
                    stop = { client.sendChatAction(agentId, "interrupt") },
                )
            }
        }
    }
}

private fun chatStatusLabel(chat: ChatState) = when (chat.status) {
    "starting" -> "Starting…"
    "working" -> "Working"
    "closed" -> "Stopped"
    else -> if (chat.requests.isNotEmpty()) "Needs input" else "Ready"
} + (chat.model?.let { " · $it" } ?: "")

@Composable
private fun Banner(text: String, error: Boolean = false) {
    Text(
        text,
        Modifier
            .fillMaxWidth()
            .background(if (error) MaterialTheme.colorScheme.errorContainer else AppTheme.extra.warningBannerBg)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        color = if (error) MaterialTheme.colorScheme.onErrorContainer else AppTheme.extra.warningText,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun ChatTranscript(
    chat: ChatState,
    agentName: String,
    canRespond: Boolean,
    respond: suspend (ChatRequest, String, Map<String, String>) -> Unit,
    modifier: Modifier,
) {
    val list = rememberLazyListState()
    val count = chat.items.size + chat.requests.size
    // Follow the conversation while the reader is at its end; leave them be if they scrolled up.
    LaunchedEffect(count, chat.items.lastOrNull()?.text?.length) {
        val last = list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
        if (count > 0 && last >= list.layoutInfo.totalItemsCount - 3) list.animateScrollToItem(count - 1)
    }
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        state = list,
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(chat.items, key = { "item:${it.id}" }) { item ->
            // New messages fade and rise in; existing ones slide when others arrive.
            Box(Modifier.animateItem(fadeInSpec = tween(220), placementSpec = spring(stiffness = Spring.StiffnessMediumLow))) {
                when (item.kind) {
                    "user" -> UserMessage(item.text)
                    "tool" -> ToolItem(item)
                    else -> SelectionContainer {
                        Text(item.text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
        }
        items(chat.requests, key = { "request:${it.id}" }) { request ->
            Box(Modifier.animateItem()) { RequestCard(request, agentName, canRespond, respond) }
        }
        if (chat.status == "working" && chat.requests.isEmpty()) {
            item(key = "typing") { TypingIndicator(Modifier.animateItem()) }
        }
    }
}

/** Three dots rising in turn while the agent works. */
@Composable
private fun TypingIndicator(modifier: Modifier) {
    val transition = rememberInfiniteTransition(label = "typing")
    Row(modifier.padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(3) { i ->
            val lift by transition.animateFloat(
                initialValue = 0f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = keyframes {
                        durationMillis = 1200
                        0f at 0 + i * 150
                        1f at 300 + i * 150
                        0f at 600 + i * 150
                    },
                ),
                label = "dot$i",
            )
            Box(
                Modifier
                    .size(7.dp)
                    .graphicsLayer {
                        translationY = -lift * 5.dp.toPx()
                        alpha = 0.4f + 0.6f * lift
                    }
                    .background(AppTheme.extra.textMuted, CircleShape),
            )
        }
    }
}

@Composable
private fun UserMessage(text: String) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        SelectionContainer {
            Text(
                text,
                Modifier
                    .widthIn(max = 320.dp)
                    .background(MaterialTheme.colorScheme.primaryContainer, MaterialTheme.shapes.small)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun ToolItem(item: ChatItem) {
    var open by rememberSaveable(item.id) { mutableStateOf(false) }
    val activity = item.activity
    val (mark, color) = when (activity?.status) {
        "running" -> "…" to AppTheme.extra.textMuted
        "failed" -> "✗" to MaterialTheme.colorScheme.error
        "declined", "interrupted" -> "–" to AppTheme.extra.warningText
        else -> "✓" to AppTheme.extra.success
    }
    val output = item.text.take(MAX_TOOL_OUTPUT)
    Column(
        Modifier
            .fillMaxWidth()
            .border(BorderStroke(1.dp, AppTheme.extra.borderSubtle), MaterialTheme.shapes.small)
            .clickable(enabled = output.isNotBlank()) { open = !open }
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(mark, color = color, fontWeight = FontWeight.Bold)
            Text(
                activity?.command ?: activity?.label ?: "Tool",
                fontFamily = if (activity?.command != null) FontFamily.Monospace else null,
                style = MaterialTheme.typography.bodySmall,
                color = AppTheme.extra.textMuted,
                maxLines = if (open) Int.MAX_VALUE else 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (open) {
            Text(
                output + if (item.text.length > MAX_TOOL_OUTPUT) "\n… (more on your computer)" else "",
                Modifier
                    .padding(top = 6.dp)
                    .horizontalScroll(rememberScrollState()),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                lineHeight = 14.sp,
                color = MaterialTheme.colorScheme.onSurface,
                softWrap = false,
            )
        }
    }
}

/** The desktop's RequestCard: an approval to allow or decline, or questions to answer. */
@Composable
private fun RequestCard(
    request: ChatRequest,
    agentName: String,
    canRespond: Boolean,
    respond: suspend (ChatRequest, String, Map<String, String>) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var answers by remember(request.id) { mutableStateOf(mapOf<String, String>()) }
    var picked by remember(request.id) { mutableStateOf(mapOf<String, List<String>>()) }
    var busy by remember(request.id) { mutableStateOf(false) }
    var error by remember(request.id) { mutableStateOf<String?>(null) }
    var showDetails by remember(request.id) { mutableStateOf(false) }
    val isQuestion = request.kind == "question"

    val haptic = LocalHapticFeedback.current
    // The card breathes like a waiting agent card, so it reads as the thing to act on.
    val glow by rememberInfiniteTransition(label = "requestGlow").animateFloat(
        initialValue = 0.45f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "requestGlowAlpha",
    )

    fun submit(decision: String) {
        haptic.performHapticFeedback(if (decision == "decline") HapticFeedbackType.Reject else HapticFeedbackType.Confirm)
        busy = true
        error = null
        scope.launch {
            try {
                respond(request, decision, answers)
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(AppTheme.extra.cardBgAttention)
            .border(BorderStroke(1.dp, AppTheme.extra.attentionBorder.copy(alpha = glow)))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            if (isQuestion) "$agentName needs your input" else "Approval needed" + (request.action?.let { ": $it" } ?: ""),
            fontWeight = FontWeight.Bold,
            color = AppTheme.extra.warningText,
        )
        if (!isQuestion) {
            Text(request.text, style = MaterialTheme.typography.bodyMedium)
            request.details?.let { details ->
                Text(
                    if (showDetails) "Hide details" else "Details",
                    Modifier.clickable { showDetails = !showDetails },
                    color = MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.bodySmall,
                )
                if (showDetails) {
                    Text(details, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp)
                }
            }
        }
        request.questions.forEach { q ->
            Text(q.question, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            if (q.options.isNotEmpty()) {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    q.options.forEach { option ->
                        val selected = if (q.multiSelect) picked[q.id].orEmpty().contains(option.label) else answers[q.id] == option.label
                        FilterChip(
                            selected = selected,
                            enabled = !busy,
                            onClick = {
                                if (q.multiSelect) {
                                    val previous = picked[q.id].orEmpty()
                                    val next = if (option.label in previous) previous - option.label else previous + option.label
                                    picked = picked + (q.id to next)
                                    answers = answers + (q.id to next.joinToString(", "))
                                } else {
                                    answers = answers + (q.id to option.label)
                                }
                            },
                            label = { Text(option.label) },
                        )
                    }
                }
            }
            OutlinedTextField(
                value = answers[q.id].orEmpty(),
                onValueChange = {
                    answers = answers + (q.id to it)
                    picked = picked + (q.id to emptyList())
                },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text(if (q.options.isEmpty()) "Your answer" else "Or type your own answer") },
                visualTransformation = if (q.isSecret) PasswordVisualTransformation() else VisualTransformation.None,
                singleLine = true,
                enabled = !busy,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            val answered = request.questions.all { answers[it.id]?.isNotBlank() == true }
            Button(
                onClick = { submit("accept") },
                enabled = canRespond && !busy && answered,
                colors = if (request.defaultToNo) ButtonDefaults.outlinedButtonColors() else ButtonDefaults.buttonColors(),
            ) { Text(if (isQuestion) "Submit answers" else "Allow once") }
            if (!isQuestion && request.canAlwaysAllow) {
                OutlinedButton(onClick = { submit("accept-always") }, enabled = canRespond && !busy) { Text("Always allow") }
            }
            if (!isQuestion) {
                OutlinedButton(onClick = { submit("decline") }, enabled = canRespond && !busy) { Text("Decline") }
            }
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        }
        if (!isQuestion && request.canAlwaysAllow) {
            request.alwaysAllowNote?.let {
                Text("Always allow will $it.", style = MaterialTheme.typography.bodySmall, color = AppTheme.extra.textMuted)
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun ChatComposer(
    draftKey: String,
    quickReplies: List<String>,
    sendQuickReplies: Boolean = false,
    promptHistory: PromptHistoryStore? = null,
    enabled: Boolean,
    working: Boolean,
    send: suspend (String) -> Unit,
    stop: suspend () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var draft by rememberSaveable(draftKey) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showHistory by remember { mutableStateOf(false) }

    fun run(action: suspend () -> Unit, clearDraft: Boolean) {
        busy = true
        error = null
        scope.launch {
            try {
                action()
                if (clearDraft) draft = ""
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        QuickReplies(quickReplies, enabled = enabled && !busy) {
            if (sendQuickReplies) run({ send(it) }, clearDraft = false)
            else draft = appendToDraft(draft, it)
        }
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Message the agent") },
            minLines = 2,
            maxLines = 6,
            enabled = enabled,
        )
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.End,
        ) {
            VoiceInputButton(enabled = enabled && !busy) { draft = appendToDraft(draft, it) }
            if (promptHistory != null) {
                OutlinedButton(
                    onClick = { showHistory = true },
                    enabled = enabled && !busy && promptHistory.history(draftKey).isNotEmpty(),
                    shape = MaterialTheme.shapes.large,
                ) {
                    Icon(Icons.Filled.History, contentDescription = "Recent messages")
                }
            }
            if (working && draft.isBlank()) {
                OutlinedButton(onClick = { run(stop, clearDraft = false) }, enabled = enabled && !busy) {
                    Icon(Icons.Filled.Stop, contentDescription = "Stop")
                }
            } else {
                Button(
                    onClick = {
                        val text = draft.trim()
                        run({ send(text); promptHistory?.record(draftKey, text) }, clearDraft = true)
                    },
                    enabled = enabled && !busy && draft.isNotBlank(),
                ) { Text("Send") }
            }
        }
        if (showHistory) {
            val history = remember(showHistory) { promptHistory?.history(draftKey).orEmpty() }
            PromptHistoryDialog(
                history = history,
                onPick = {
                    draft = appendToDraft(draft, it)
                    showHistory = false
                },
                onDismiss = { showHistory = false },
            )
        }
    }
}
