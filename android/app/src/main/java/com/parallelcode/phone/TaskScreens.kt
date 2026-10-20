package com.parallelcode.phone

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// Matches MAX_NOTES_BYTES in electron/remote/server.ts.
private const val MAX_NOTES_BYTES = 100 * 1024

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewTaskScreen(client: RemoteClient, onDone: () -> Unit, onNeedsPairing: () -> Unit) {
    val scope = rememberCoroutineScope()
    var projects by remember { mutableStateOf<List<MobileProject>?>(null) }
    var loadAttempt by remember { mutableIntStateOf(0) }
    var projectId by rememberSaveable { mutableStateOf("") }
    var agents by remember { mutableStateOf<List<MobileAgentChoice>>(emptyList()) }
    var agentsLoaded by remember { mutableStateOf(false) }
    var agentId by rememberSaveable { mutableStateOf("") }
    // Empty runs the agent with the model its desktop settings configure.
    var modelId by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var prompt by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Same default title as the phone web UI: the start of the prompt.
    val title = name.trim().ifEmpty { prompt.trim().replace(Regex("\\s+"), " ").take(80) }

    fun failed(e: ApiException, suffix: String = "") {
        // The client has already dropped a rejected paired token.
        if (e.status == 401) onNeedsPairing() else error = e.message + suffix
    }

    LaunchedEffect(loadAttempt) {
        error = null
        try {
            val list = client.fetchProjects()
            projects = list
            if (list.none { it.id == projectId }) projectId = list.firstOrNull()?.id.orEmpty()
        } catch (e: ApiException) {
            projects = emptyList()
            failed(e)
            return@LaunchedEffect
        }
        try {
            val choices = client.fetchAgentChoices()
            agents = choices
            val agent = choices.find { it.id == agentId } ?: choices.find { it.isDefault } ?: choices.firstOrNull()
            agentId = agent?.id.orEmpty()
            if (agent?.models?.none { it.id == modelId } != false) modelId = ""
        } catch (e: ApiException) {
            // Without the list the desktop still starts its default agent.
            agents = emptyList()
            agentId = ""
            modelId = ""
            if (e.status == 401) onNeedsPairing()
        }
        agentsLoaded = true
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
                        TextButton(onClick = onDone, enabled = !busy) {
                            Text("Cancel", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                        }
                    },
                    title = {
                        Text("New task", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge)
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
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            val loaded = projects
            when {
                loaded == null -> Text("Loading projects…", color = AppTheme.extra.textMuted)
                loaded.isEmpty() -> {
                    Text(
                        "No projects available. Add one in Parallel Code on your computer.",
                        color = AppTheme.extra.textMuted,
                    )
                    TextButton(onClick = { loadAttempt++ }) { Text("Retry") }
                }
                else -> {
                    SelectField(
                        label = "Project",
                        options = loaded,
                        selected = loaded.find { it.id == projectId },
                        optionLabel = { it.name },
                        onSelect = { projectId = it.id },
                        enabled = !busy,
                    )
                    val agent = agents.find { it.id == agentId }
                    if (agent == null) {
                        // An older desktop lists no agents; say which one it will start.
                        if (agentsLoaded) {
                            loaded.find { it.id == projectId }?.agentName?.let {
                                Text("Runs with $it", style = MaterialTheme.typography.bodySmall, color = AppTheme.extra.textMuted)
                            }
                        }
                    } else {
                        SelectField(
                            label = "Agent",
                            options = agents,
                            selected = agent,
                            optionLabel = { it.name },
                            onSelect = {
                                if (it.id != agentId) modelId = ""
                                agentId = it.id
                            },
                            enabled = !busy,
                        )
                        if (agent.models.isNotEmpty()) {
                            val defaultModel = AgentModel("", "Default")
                            SelectField(
                                label = "Model",
                                options = listOf(defaultModel) + agent.models,
                                selected = agent.models.find { it.id == modelId } ?: defaultModel,
                                optionLabel = { it.label },
                                onSelect = { modelId = it.id },
                                enabled = !busy,
                            )
                        }
                    }
                }
            }
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 140.dp),
                label = { Text("What should the agent work on?") },
                enabled = !busy,
                shape = MaterialTheme.shapes.large,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = AppTheme.extra.inputBg,
                    unfocusedContainerColor = AppTheme.extra.inputBg,
                    focusedBorderColor = MaterialTheme.colorScheme.primary,
                    unfocusedBorderColor = AppTheme.extra.border,
                ),
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Task name (optional)") },
                placeholder = { Text(title, color = AppTheme.extra.textSubtle) },
                singleLine = true,
                enabled = !busy,
                shape = MaterialTheme.shapes.large,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = AppTheme.extra.inputBg,
                    unfocusedContainerColor = AppTheme.extra.inputBg,
                    focusedBorderColor = MaterialTheme.colorScheme.primary,
                    unfocusedBorderColor = AppTheme.extra.border,
                ),
            )
            AnimatedVisibility(
                visible = error != null,
                enter = expandVertically() + fadeIn(),
                exit = shrinkVertically() + fadeOut(),
            ) {
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            val createInteractionSource = remember { MutableInteractionSource() }
            val isCreatePressed by createInteractionSource.collectIsPressedAsState()
            val createScale by animateFloatAsState(
                targetValue = if (isCreatePressed) 0.96f else 1f,
                animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow),
                label = "createButtonScale",
            )
            Button(
                interactionSource = createInteractionSource,
                modifier = Modifier
                    .fillMaxWidth()
                    .graphicsLayer {
                        scaleX = createScale
                        scaleY = createScale
                    },
                enabled = !busy && projectId.isNotEmpty() && prompt.isNotBlank(),
                shape = MaterialTheme.shapes.large,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            client.createTask(
                                projectId,
                                title,
                                prompt.trim(),
                                agentId.ifEmpty { null },
                                modelId.ifEmpty { null },
                            )
                            onDone()
                        } catch (e: ApiException) {
                            failed(
                                e,
                                " Your draft is kept. If the connection dropped, check the task list before retrying.",
                            )
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text(if (busy) "Creating…" else "Create task", fontWeight = FontWeight.Bold) }
        }
    }
}

/** A read-only dropdown, the phone's equivalent of an HTML select. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> SelectField(
    label: String,
    options: List<T>,
    selected: T?,
    optionLabel: (T) -> String,
    onSelect: (T) -> Unit,
    enabled: Boolean,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(
        expanded = expanded && enabled,
        onExpandedChange = { if (enabled) expanded = it },
    ) {
        OutlinedTextField(
            value = selected?.let(optionLabel).orEmpty(),
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            enabled = enabled,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded && enabled) },
            shape = MaterialTheme.shapes.large,
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = AppTheme.extra.inputBg,
                unfocusedContainerColor = AppTheme.extra.inputBg,
                focusedBorderColor = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = AppTheme.extra.border,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable, enabled),
        )
        ExposedDropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = {
                        Text(
                            optionLabel(option),
                            fontWeight = if (option == selected) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    },
                    onClick = {
                        onSelect(option)
                        expanded = false
                    },
                    contentPadding = ExposedDropdownMenuDefaults.ItemContentPadding,
                )
            }
        }
    }
}

/** The task's notes panel from the desktop; editable once the phone is paired. */
@Composable
fun NotesPane(taskId: String, canEdit: Boolean, client: RemoteClient, modifier: Modifier) {
    val scope = rememberCoroutineScope()
    var notes by rememberSaveable(taskId) { mutableStateOf("") }
    var dirty by rememberSaveable(taskId) { mutableStateOf(false) }
    var loaded by remember(taskId) { mutableStateOf(false) }
    var loadAttempt by remember { mutableIntStateOf(0) }
    var saving by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(taskId, loadAttempt) {
        error = null
        try {
            val remote = client.fetchNotes(taskId)
            // Keep unsaved edits rather than overwrite them with the desktop's copy.
            if (!dirty) notes = remote
            loaded = true
        } catch (e: ApiException) {
            error = e.message
        }
    }

    Column(modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = notes,
            onValueChange = {
                notes = it
                dirty = true
                saved = false
            },
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            placeholder = { Text(if (loaded) "No notes yet" else "Loading notes…", color = AppTheme.extra.textSubtle) },
            readOnly = !canEdit || !loaded,
            shape = MaterialTheme.shapes.large,
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = AppTheme.extra.inputBg,
                unfocusedContainerColor = AppTheme.extra.inputBg,
                focusedBorderColor = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = AppTheme.extra.border,
            ),
        )
        AnimatedVisibility(
            visible = error != null,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            AnimatedContent(
                targetState = when {
                    saving -> "saving"
                    dirty -> "dirty"
                    saved -> "saved"
                    else -> "idle"
                },
                transitionSpec = { fadeIn() togetherWith fadeOut() },
                label = "notesStatusAnimation",
                modifier = Modifier.weight(1f),
            ) { status ->
                Text(
                    text = when (status) {
                        "saving" -> "Saving…"
                        "dirty" -> "Unsaved changes"
                        "saved" -> "✓ Saved to your computer"
                        else -> ""
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = when (status) {
                        "dirty" -> AppTheme.extra.warningText
                        "saved" -> AppTheme.extra.success
                        else -> AppTheme.extra.textMuted
                    },
                )
            }
            if (!loaded) TextButton(onClick = { loadAttempt++ }) { Text("Reload") }
            if (canEdit) {
                val saveInteractionSource = remember { MutableInteractionSource() }
                val isSavePressed by saveInteractionSource.collectIsPressedAsState()
                val saveScale by animateFloatAsState(
                    targetValue = if (isSavePressed) 0.94f else 1f,
                    animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow),
                    label = "saveButtonScale",
                )
                Button(
                    interactionSource = saveInteractionSource,
                    modifier = Modifier.graphicsLayer {
                        scaleX = saveScale
                        scaleY = saveScale
                    },
                    enabled = loaded && dirty && !saving,
                    shape = MaterialTheme.shapes.large,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                    onClick = {
                        if (notes.toByteArray().size > MAX_NOTES_BYTES) {
                            error = "Notes must be 100 KB or less."
                            return@Button
                        }
                        saving = true
                        error = null
                        val text = notes
                        scope.launch {
                            try {
                                client.saveNotes(taskId, text)
                                // Typing during the save keeps the note marked unsaved.
                                if (notes == text) {
                                    dirty = false
                                    saved = true
                                }
                            } catch (e: ApiException) {
                                error = e.message
                            } finally {
                                saving = false
                            }
                        }
                    },
                ) { Text("Save", fontWeight = FontWeight.Bold) }
            }
        }
    }
}
