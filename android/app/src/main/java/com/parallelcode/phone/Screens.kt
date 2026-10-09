package com.parallelcode.phone

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import kotlinx.coroutines.delay
import kotlin.math.roundToInt
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.platform.LocalDensity
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.launch
import java.io.IOException

private const val NOT_A_LINK = "That isn't a Parallel Code link. Open Connect Phone on your computer and try again."

@Composable
fun ConnectScreen(
    expired: Boolean,
    onLink: (ConnectionLink) -> Unit,
    saved: List<SavedComputer> = emptyList(),
    onSelectSaved: (String) -> Unit = {},
    onCancel: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    var pasted by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    fun accept(raw: String) {
        val link = ConnectionLink.parse(raw)
        if (link == null) error = NOT_A_LINK else onLink(link)
    }

    SetupPage(title = "Connect to your computer") {
        if (expired) {
            Surface(
                shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.errorContainer,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "This link no longer works. Your computer restarted Remote Access or disconnected this phone.",
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.padding(12.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        Text(
            "On your computer, open Connect Phone and scan the QR code.",
            color = AppTheme.extra.textMuted,
            style = MaterialTheme.typography.bodyMedium,
        )
        Button(
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.large,
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ),
            onClick = {
                error = null
                val options = GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                    .build()
                GmsBarcodeScanning.getClient(context, options).startScan()
                    .addOnSuccessListener { accept(it.rawValue.orEmpty()) }
                    .addOnFailureListener { error = "The scanner isn't available. Paste the link instead." }
            },
        ) { Text("Scan QR code", fontWeight = FontWeight.SemiBold) }
        Text(
            "Or paste the link shown under the QR code:",
            style = MaterialTheme.typography.bodySmall,
            color = AppTheme.extra.textMuted,
        )
        OutlinedTextField(
            value = pasted,
            onValueChange = { pasted = it },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            placeholder = { Text("http://192.168.1.20:7777/?token=…") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            shape = MaterialTheme.shapes.large,
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = AppTheme.extra.inputBg,
                unfocusedContainerColor = AppTheme.extra.inputBg,
                focusedBorderColor = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = AppTheme.extra.border,
            ),
        )
        TextButton(onClick = { accept(pasted) }, enabled = pasted.isNotBlank()) {
            Text("Connect", fontWeight = FontWeight.SemiBold)
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (saved.isNotEmpty()) {
            Text(
                "Or use a computer you've linked before:",
                style = MaterialTheme.typography.bodySmall,
                color = AppTheme.extra.textMuted,
            )
            saved.forEach { computer ->
                OutlinedButton(onClick = { onSelectSaved(computer.baseUrl) }, modifier = Modifier.fillMaxWidth()) {
                    Text(computer.label, fontFamily = FontFamily.Monospace)
                }
            }
        }
        if (onCancel == null) {
            Text(
                "Set up this phone before? Restore its backup:",
                style = MaterialTheme.typography.bodySmall,
                color = AppTheme.extra.textMuted,
            )
            RestoreBackupButton(Modifier.fillMaxWidth())
        }
        onCancel?.let { TextButton(onClick = it) { Text("Cancel") } }
    }
}

@Composable
fun PairScreen(pair: suspend (pin: String, remember: Boolean) -> Unit, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var pin by rememberSaveable { mutableStateOf("") }
    var remember by rememberSaveable { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    SetupPage(title = "Enable replies") {
        Text(
            "Enter the six-digit code from Connect Phone on your computer to send messages to agents.",
            color = AppTheme.extra.textMuted,
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = pin,
            onValueChange = { pin = it.filter(Char::isDigit).take(6) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Code from your computer") },
            singleLine = true,
            enabled = !busy,
            textStyle = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            shape = MaterialTheme.shapes.large,
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = AppTheme.extra.inputBg,
                unfocusedContainerColor = AppTheme.extra.inputBg,
                focusedBorderColor = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = AppTheme.extra.border,
            ),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Keep this phone authorized", fontWeight = FontWeight.Medium)
                Text(
                    "Stay paired after your computer restarts. Use only on a phone you trust.",
                    style = MaterialTheme.typography.bodySmall,
                    color = AppTheme.extra.textMuted,
                )
            }
            Switch(
                checked = remember,
                onCheckedChange = { remember = it },
                enabled = !busy,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                    checkedTrackColor = MaterialTheme.colorScheme.primary,
                ),
            )
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            modifier = Modifier.fillMaxWidth(),
            enabled = pin.length == 6 && !busy,
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
                        pair(pin, remember)
                        onDone()
                    } catch (e: ApiException) {
                        error = e.message
                    } finally {
                        busy = false
                    }
                }
            },
        ) { Text(if (busy) "Authorizing…" else "Enable replies", fontWeight = FontWeight.SemiBold) }
        TextButton(modifier = Modifier.fillMaxWidth(), onClick = onDone, enabled = !busy) {
            Text("Continue viewing only")
        }
    }
}

@Composable
private fun SetupPage(title: String, content: @Composable () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onBackground,
            )
            content()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentsScreen(
    client: RemoteClient,
    host: String,
    state: ConnectionState,
    agents: List<RemoteAgent>,
    showMinimizedTasks: Boolean,
    onOpen: (RemoteAgent) -> Unit,
    onPair: () -> Unit,
    onNewTask: () -> Unit,
    onSettings: () -> Unit,
    computers: List<SavedComputer> = emptyList(),
    onSwitchComputer: (String) -> Unit = {},
    search: String = "",
    onSearch: (String) -> Unit = {},
    filter: TaskFilter = TaskFilter.ALL,
    onFilter: (TaskFilter) -> Unit = {},
) {
    var refreshing by remember { mutableStateOf(false) }
    var showSwitchMenu by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val activeAgents = remember(agents) { agents.filter { !it.collapsed } }
    val minimizedAgents = remember(agents) { agents.filter { it.collapsed } }
    val matchingSearch = remember(activeAgents, search) { activeAgents.filter { matchesSearch(it, search) } }
    val groups = remember(matchingSearch, filter) { groupTasks(matchingSearch.filter(filter::matches)) }
    val showHostSwitch = computers.size > 1
    val hostLabel = computers.firstOrNull { it.baseUrl == host }?.label
        ?: host.substringAfter("://")
    val latencyMs by client.latencyMs.collectAsState()
    val latencySegment =
        if (state.status == ConnectionStatus.CONNECTED && latencyMs != null) " · $latencyMs ms" else ""

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        titleContentColor = MaterialTheme.colorScheme.onSurface,
                        actionIconContentColor = MaterialTheme.colorScheme.primary,
                    ),
                    title = {
                        Column {
                            Text(
                                "Agents",
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Bold,
                            )
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                val statusDotColor = when (state.status) {
                                    ConnectionStatus.CONNECTED -> AppTheme.extra.success
                                    ConnectionStatus.CONNECTING, ConnectionStatus.WAITING_FOR_VPN -> AppTheme.extra.warningText
                                    ConnectionStatus.DISCONNECTED -> MaterialTheme.colorScheme.error
                                }
                                val infiniteTransition = rememberInfiniteTransition(label = "connPulse")
                                val pulseAlpha by if (state.status == ConnectionStatus.CONNECTED) {
                                    infiniteTransition.animateFloat(
                                        initialValue = 0.45f,
                                        targetValue = 1f,
                                        animationSpec = infiniteRepeatable(
                                            animation = tween(1200, easing = FastOutSlowInEasing),
                                            repeatMode = RepeatMode.Reverse,
                                        ),
                                        label = "connDotAlpha",
                                    )
                                } else {
                                    remember { mutableFloatStateOf(1f) }
                                }
                                Box(
                                    Modifier
                                        .size(7.dp)
                                        .clip(CircleShape)
                                        .background(statusDotColor.copy(alpha = pulseAlpha)),
                                )
                                Text(
                                    "${statusLabel(state)}$latencySegment · $hostLabel",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = AppTheme.extra.textMuted,
                                )
                            }
                        }
                    },
                    actions = {
                        if (showHostSwitch) {
                            Box {
                                TextButton(onClick = { showSwitchMenu = true }) {
                                    Text("Switch", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Medium)
                                }
                                DropdownMenu(
                                    expanded = showSwitchMenu,
                                    onDismissRequest = { showSwitchMenu = false },
                                ) {
                                    computers.forEach { computer ->
                                        val inUse = computer.baseUrl == host
                                        DropdownMenuItem(
                                            text = {
                                                Column {
                                                    Text(
                                                        computer.label,
                                                        fontFamily = FontFamily.Monospace,
                                                        fontWeight = if (inUse) FontWeight.SemiBold else FontWeight.Normal,
                                                    )
                                                    Text(
                                                        (if (inUse) "In use · " else "") + if (computer.pairedToken != null) "Paired" else "View only",
                                                        style = MaterialTheme.typography.bodySmall,
                                                        color = AppTheme.extra.textMuted,
                                                    )
                                                }
                                            },
                                            onClick = {
                                                showSwitchMenu = false
                                                if (!inUse) onSwitchComputer(computer.baseUrl)
                                            },
                                            trailingIcon = if (inUse) {
                                                {
                                                    Text(
                                                        "✓",
                                                        color = MaterialTheme.colorScheme.primary,
                                                        fontWeight = FontWeight.Bold,
                                                    )
                                                }
                                            } else null,
                                        )
                                    }
                                }
                            }
                        }
                        if (state.canControl) {
                            Button(
                                onClick = onNewTask,
                                shape = MaterialTheme.shapes.small,
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = MaterialTheme.colorScheme.primary,
                                    contentColor = MaterialTheme.colorScheme.onPrimary,
                                ),
                                modifier = Modifier.padding(end = 4.dp),
                            ) {
                                Text("New task", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
                            }
                        }
                        TextButton(onClick = onSettings) {
                            Text("Settings", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Medium)
                        }
                    },
                )
                HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.border)
            }
        },
        bottomBar = {
            if (showMinimizedTasks && minimizedAgents.isNotEmpty()) {
                MinimizedTasksBottomBar(
                    minimizedAgents = minimizedAgents,
                    onOpen = onOpen,
                )
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    client.reconnect()
                    // The connection status already reports an outage; the strip keeps its last reading.
                    runCatching { client.fetchUsage() }
                    delay(600)
                    refreshing = false
                }
            },
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            LazyColumn(
                Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(vertical = 12.dp),
            ) {
                item { UsageStrip(client, connected = state.status == ConnectionStatus.CONNECTED) }
                item { UpdateBanner() }
                if (state.status == ConnectionStatus.CONNECTED && !state.canControl) {
                    item { PairBanner(onPair) }
                }
                if (state.status == ConnectionStatus.CONNECTED && activeAgents.isEmpty()) {
                    item {
                        Text(
                            if (showMinimizedTasks && minimizedAgents.isNotEmpty()) "No active agents running." else "No agents are running.",
                            Modifier.padding(24.dp),
                            color = AppTheme.extra.textMuted,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                }
                if (state.status != ConnectionStatus.CONNECTED && activeAgents.isEmpty() && (!showMinimizedTasks || minimizedAgents.isEmpty())) {
                    item {
                        Row(
                            Modifier.padding(24.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CircularProgressIndicator(
                                Modifier.size(20.dp),
                                color = MaterialTheme.colorScheme.primary,
                                strokeWidth = 2.dp,
                            )
                            Spacer(Modifier.width(12.dp))
                            Text(
                                if (state.status == ConnectionStatus.WAITING_FOR_VPN) "Waiting for VPN connection…" else "Reaching your computer…",
                                color = AppTheme.extra.textMuted,
                            )
                        }
                    }
                }
                if (activeAgents.isNotEmpty()) {
                    item(key = "task-filters") {
                        TaskSearchAndFilters(
                            search = search,
                            onSearch = onSearch,
                            filter = filter,
                            onFilter = onFilter,
                            countFor = { option -> matchingSearch.count(option::matches) },
                        )
                    }
                    if (groups.isEmpty()) {
                        item(key = "no-matching-tasks") {
                            NoMatchingTasks(search, filter) {
                                onSearch("")
                                onFilter(TaskFilter.ALL)
                            }
                        }
                    }
                }
                groups.forEach { (group, groupAgents) ->
                    item(key = "group:${group.name}") {
                        TaskGroupHeader(group, groupAgents.size, Modifier.animateItem())
                    }
                    items(groupAgents, key = { it.agentId }) { agent ->
                        AgentCard(agent, onOpen, modifier = Modifier.animateItem())
                    }
                }
            }
        }
    }
}

@Composable
private fun MinimizedTasksBottomBar(
    minimizedAgents: List<RemoteAgent>,
    onOpen: (RemoteAgent) -> Unit,
    modifier: Modifier = Modifier,
) {
    var isExpanded by rememberSaveable { mutableStateOf(true) }
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, AppTheme.extra.border),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { isExpanded = !isExpanded }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(AppTheme.extra.textMuted),
                    )
                    Text(
                        "Minimized (${minimizedAgents.size})",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
                Text(
                    if (isExpanded) "Hide" else "Show",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            AnimatedVisibility(
                visible = isExpanded,
                enter = expandVertically(animationSpec = tween(220, easing = FastOutSlowInEasing)) + fadeIn(tween(180)),
                exit = shrinkVertically(animationSpec = tween(200, easing = FastOutSlowInEasing)) + fadeOut(tween(150)),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    minimizedAgents.forEach { agent ->
                        MinimizedTaskCard(
                            agent = agent,
                            onClick = { onOpen(agent) },
                            single = minimizedAgents.size == 1,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MinimizedTaskCard(
    agent: RemoteAgent,
    onClick: () -> Unit,
    single: Boolean,
) {
    Card(
        modifier = Modifier
            .width(if (single) 260.dp else 220.dp)
            .clickable(onClick = onClick),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = AppTheme.extra.cardBg),
        border = BorderStroke(1.dp, AppTheme.extra.borderSubtle),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = agent.taskName,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = AppTheme.extra.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "Minimized",
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                    color = AppTheme.extra.textMuted,
                )
            }
            listOfNotNull(agent.projectName, agent.agentName).takeIf { it.isNotEmpty() }?.let {
                Text(
                    text = it.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                    color = AppTheme.extra.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (agent.lastLine.isNotBlank()) {
                Text(
                    text = agent.lastLine,
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, lineHeight = 14.sp),
                    fontFamily = FontFamily.Monospace,
                    color = AppTheme.extra.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
internal fun PairBanner(onPair: () -> Unit) {
    Card(
        modifier = Modifier.padding(horizontal = 16.dp),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = AppTheme.extra.warningBannerBg),
        border = BorderStroke(1.dp, AppTheme.extra.attentionBorder),
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "View only. Pair to send replies.",
                Modifier.weight(1f),
                color = AppTheme.extra.warningText,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            Button(
                onClick = onPair,
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(
                    containerColor = AppTheme.extra.attentionBorder,
                    contentColor = AppTheme.extra.warningText,
                ),
            ) { Text("Pair", fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun AgentCard(
    agent: RemoteAgent,
    onOpen: (RemoteAgent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val isAttention = !agent.collapsed && (agent.attention == "needs_input" || agent.attention == "error")
    val attentionTransition = rememberInfiniteTransition(label = "attentionPulse")
    val attentionGlow by if (isAttention) {
        attentionTransition.animateFloat(
            initialValue = 0.45f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(900, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "attentionGlow",
        )
    } else {
        remember { mutableFloatStateOf(1f) }
    }

    val cardBorderColor = if (isAttention) {
        if (agent.attention == "error") MaterialTheme.colorScheme.error.copy(alpha = attentionGlow)
        else AppTheme.extra.attentionBorder.copy(alpha = attentionGlow)
    } else {
        AppTheme.extra.border
    }
    val cardBg by animateColorAsState(
        if (isAttention) AppTheme.extra.cardBgAttention else AppTheme.extra.cardBg,
        animationSpec = tween(300),
        label = "cardBg",
    )
    // A card that just started needing you bumps once, so the change catches the eye.
    val bump = remember { Animatable(1f) }
    LaunchedEffect(isAttention) {
        if (!isAttention) return@LaunchedEffect
        bump.animateTo(1.03f, tween(140))
        bump.animateTo(1f, spring(dampingRatio = Spring.DampingRatioMediumBouncy))
    }

    val (statusColor, statusText) = when {
        agent.collapsed -> Pair(AppTheme.extra.textMuted, "Minimized")
        !agent.running -> Pair(AppTheme.extra.textMuted, agent.exitCode?.let { "Exited ($it)" } ?: "Exited")
        agent.attention == "needs_input" -> Pair(AppTheme.extra.warningText, "Needs input")
        agent.attention == "error" -> Pair(MaterialTheme.colorScheme.error, "Error")
        agent.attention == "active" -> Pair(MaterialTheme.colorScheme.primary, "Working")
        agent.attention == "shell_busy" -> Pair(MaterialTheme.colorScheme.primary, "Running command")
        agent.attention == "ready" -> Pair(AppTheme.extra.success, "Ready")
        agent.attention == "review" -> Pair(AppTheme.extra.review, "Review")
        else -> Pair(AppTheme.extra.textMuted, "Idle")
    }

    val isWorking = !agent.collapsed && agent.running && (agent.attention == "active" || agent.attention == "shell_busy")
    val infiniteTransition = rememberInfiniteTransition(label = "agentWorkingPulse")
    val dotAlpha by if (isWorking) {
        infiniteTransition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(800, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "workingDotAlpha",
        )
    } else {
        remember { mutableFloatStateOf(1f) }
    }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .graphicsLayer {
                scaleX = bump.value
                scaleY = bump.value
            }
            .clickable { onOpen(agent) },
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = cardBg),
        border = BorderStroke(1.dp, cardBorderColor),
    ) {
        Column(
            Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    agent.taskName,
                    Modifier.weight(1f),
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.titleMedium,
                    color = AppTheme.extra.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Surface(
                    shape = MaterialTheme.shapes.large,
                    color = statusColor.copy(alpha = 0.12f),
                    border = BorderStroke(1.dp, statusColor.copy(alpha = 0.35f)),
                ) {
                    Row(
                        Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(statusColor.copy(alpha = dotAlpha)),
                        )
                        Text(
                            statusText,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = statusColor,
                        )
                    }
                }
            }
            listOfNotNull(agent.projectName, agent.agentName).takeIf { it.isNotEmpty() }?.let {
                Text(
                    it.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = AppTheme.extra.textMuted,
                )
            }
            val detail = agent.lastLine.ifBlank { if (agent.isChat) "Built-in chat" else "" }
            if (detail.isNotBlank()) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(MaterialTheme.shapes.small)
                        .background(MaterialTheme.colorScheme.background)
                        .border(BorderStroke(1.dp, AppTheme.extra.borderSubtle), MaterialTheme.shapes.small)
                        .padding(horizontal = 10.dp, vertical = 7.dp),
                ) {
                    Text(
                        detail,
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
                        fontFamily = FontFamily.Monospace,
                        color = AppTheme.extra.textMuted,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentScreen(
    agent: RemoteAgent?,
    agentId: String,
    state: ConnectionState,
    client: RemoteClient,
    alwaysFollowOutput: Boolean,
    fitTerminalToPhone: Boolean,
    promptHistory: PromptHistoryStore? = null,
    pageLabel: String? = null,
    nextNeedingYou: RemoteAgent? = null,
    onOpenTask: (agentId: String) -> Unit = {},
    onZoomedChange: (Boolean) -> Unit = {},
    onBack: () -> Unit,
    onPair: () -> Unit,
) {
    val buffer = remember(agentId) { client.getTerminalBuffer(agentId) }
    val version by buffer.version.collectAsState()
    // Recomposition is batched per frame, so a burst of output renders the text once.
    val lines = remember(version) { buffer.screen.styledLines() }
    var tab by rememberSaveable { mutableStateOf(AgentTab.TERMINAL) }
    var closing by remember { mutableStateOf(false) }
    var merging by remember { mutableStateOf(false) }
    var viewSize by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    var terminalExpanded by rememberSaveable { mutableStateOf(false) }
    BackHandler(enabled = terminalExpanded) { terminalExpanded = false }
    // A task minimized on the desktop shows no terminal, so nothing would offer the way back.
    LaunchedEffect(agent?.collapsed) { if (agent?.collapsed == true) terminalExpanded = false }

    // With "Fit the terminal to this phone" on and paired, the PTY takes this screen's size so
    // full-screen TUIs fill the phone; leaving
    // the screen hands it back to the desktop. Settle first: the keyboard animates the height.
    val sizeTerminal = fitTerminalToPhone && state.canControl && agent != null && agent.running && agent.collapsed != true
    LaunchedEffect(sizeTerminal, viewSize) {
        val (cols, rows) = viewSize ?: return@LaunchedEffect
        if (!sizeTerminal) {
            client.releaseViewSize(agentId)
            return@LaunchedEffect
        }
        delay(300)
        client.setViewSize(agentId, cols, rows)
    }
    DisposableEffect(agentId) {
        onDispose {
            client.releaseTerminal(agentId)
            client.releaseViewSize(agentId)
        }
    }

    if (merging && agent != null) {
        MergeTaskDialog(
            taskId = agent.taskId,
            client = client,
            onDismiss = { merging = false },
            onMerged = {
                merging = false
                onBack()
            },
        )
    }

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
            if (!terminalExpanded) Column {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        titleContentColor = MaterialTheme.colorScheme.onSurface,
                        navigationIconContentColor = MaterialTheme.colorScheme.primary,
                    ),
                    navigationIcon = {
                        TextButton(onClick = onBack) {
                            Text("Back", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                        }
                    },
                    title = {
                        Column {
                            Text(
                                agent?.taskName ?: "Agent",
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                (agent?.let(::agentStatusLabel) ?: statusLabel(state)) + (pageLabel?.let { " · $it" } ?: ""),
                                style = MaterialTheme.typography.bodySmall,
                                color = AppTheme.extra.textMuted,
                            )
                        }
                    },
                    actions = {
                        if (tab == AgentTab.TERMINAL && agent?.collapsed != true) {
                            IconButton(onClick = { terminalExpanded = true }) {
                                Icon(Icons.Filled.Fullscreen, contentDescription = "Expand terminal")
                            }
                        }
                        if (agent != null && state.canControl) {
                            TextButton(onClick = { merging = true }) {
                                Text("Merge", fontWeight = FontWeight.SemiBold)
                            }
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
            if (!terminalExpanded) PrimaryTabRow(
                selectedTabIndex = tab.ordinal,
                containerColor = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.primary,
                divider = { HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.border) },
            ) {
                AgentTab.entries.forEach {
                    Tab(
                        selected = tab == it,
                        onClick = { tab = it },
                        text = {
                            Text(
                                it.label,
                                fontWeight = if (tab == it) FontWeight.Bold else FontWeight.Normal,
                            )
                        },
                    )
                }
            }
            AnimatedContent(
                targetState = tab,
                transitionSpec = {
                    if (targetState.ordinal > initialState.ordinal) {
                        (slideInHorizontally(animationSpec = tween(220)) { width -> width / 4 } + fadeIn(tween(180)))
                            .togetherWith(slideOutHorizontally(animationSpec = tween(200)) { width -> -width / 4 } + fadeOut(tween(160)))
                    } else {
                        (slideInHorizontally(animationSpec = tween(220)) { width -> -width / 4 } + fadeIn(tween(180)))
                            .togetherWith(slideOutHorizontally(animationSpec = tween(200)) { width -> width / 4 } + fadeOut(tween(160)))
                    }
                },
                modifier = Modifier.weight(1f),
                label = "agentTabTransition",
            ) { currentTab ->
                when (currentTab) {
                    AgentTab.TERMINAL -> if (agent?.collapsed == true) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(24.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    "This task is minimized on your computer.",
                                    style = MaterialTheme.typography.bodyLarge,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                Text(
                                    "Expand it on desktop to resume terminal interaction.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = AppTheme.extra.textMuted,
                                )
                            }
                        }
                    } else {
                        Box(Modifier.fillMaxSize()) {
                            TerminalText(
                                lines,
                                buffer.screen.cols,
                                Modifier.fillMaxSize(),
                                alwaysFollow = alwaysFollowOutput,
                                fitToView = sizeTerminal,
                                onViewSize = { cols, rows -> viewSize = cols to rows },
                                onZoomedChange = onZoomedChange,
                                // Keeps an agent's prompt clear of the Next task pill below it.
                                bottomInset = if (nextNeedingYou != null) 44.dp else 0.dp,
                            )
                            // Jump straight to the next task waiting on you, as the phone web UI does.
                            nextNeedingYou?.let { next ->
                                TerminalPill(
                                    "Next task →",
                                    onClick = { onOpenTask(next.agentId) },
                                    modifier = Modifier
                                        .align(Alignment.BottomStart)
                                        .padding(start = 16.dp, bottom = 12.dp)
                                        .semantics { contentDescription = "Next task needing you: ${next.taskName}" },
                                )
                            }
                            if (terminalExpanded) {
                                IconButton(
                                    onClick = { terminalExpanded = false },
                                    modifier = Modifier
                                        .align(Alignment.TopEnd)
                                        .padding(4.dp),
                                ) {
                                    Icon(
                                        Icons.Filled.FullscreenExit,
                                        contentDescription = "Restore terminal layout",
                                        tint = AppTheme.extra.textMuted,
                                    )
                                }
                            }
                        }
                    }
                    AgentTab.NOTES -> if (agent != null) {
                        NotesPane(agent.taskId, state.canControl, client, Modifier.fillMaxSize())
                    } else {
                        Text(
                            "This agent is no longer running.",
                            Modifier
                                .fillMaxSize()
                                .padding(16.dp),
                            color = AppTheme.extra.textMuted,
                        )
                    }
                    AgentTab.CHANGES -> if (agent != null) {
                        DiffPane(agent.taskId, client, Modifier.fillMaxSize())
                    } else {
                        Text(
                            "This agent is no longer running.",
                            Modifier
                                .fillMaxSize()
                                .padding(16.dp),
                            color = AppTheme.extra.textMuted,
                        )
                    }
                }
            }
            if (!state.canControl) {
                Spacer(Modifier.height(8.dp))
                PairBanner(onPair)
                Spacer(Modifier.height(8.dp))
            } else if (tab == AgentTab.TERMINAL && agent?.collapsed != true) {
                ReplyBox(
                    agentId = agentId,
                    compact = terminalExpanded,
                    working = agent?.running == true &&
                        (agent.attention == "active" || agent.attention == "shell_busy"),
                    promptHistory = promptHistory,
                    needsInput = agent?.attention == "needs_input",
                    sendsLineBreaksAsSpaces = !buffer.screen.bracketedPaste,
                    send = { draft, shell ->
                        val data = messageForTerminal(draft, buffer.screen.bracketedPaste)
                        if (data.isNotEmpty()) {
                            client.sendInput(agentId, data, submit = true, prefixKey = if (shell) "!" else null)
                        }
                    },
                    sendKey = { client.sendInput(agentId, it, submit = false) },
                )
            }
        }
    }
}

/**
 * Confirms closing a task, as the desktop's Close Task dialog does. The first confirm asks the
 * desktop to close only if no work would be lost; if it answers with warnings, they are shown and
 * a second confirm forces the close.
 */
@Composable
internal fun CloseTaskDialog(
    taskName: String,
    close: suspend (force: Boolean) -> List<String>,
    onDismiss: () -> Unit,
    onClosed: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var warnings by remember { mutableStateOf<List<String>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit() {
        val force = warnings.isNotEmpty()
        busy = true
        error = null
        scope.launch {
            try {
                val refused = close(force)
                if (refused.isEmpty()) onClosed() else warnings = refused
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
        title = { Text("Close task?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "“$taskName” closes on your computer: its agents and shells stop, and its worktree, if any, is removed.",
                    color = AppTheme.extra.textMuted,
                )
                warnings.forEach {
                    Text(
                        it,
                        Modifier
                            .fillMaxWidth()
                            .background(AppTheme.extra.warningBannerBg)
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        color = AppTheme.extra.warningText,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(onClick = ::submit, enabled = !busy) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text(
                        if (warnings.isEmpty()) "Close" else "Close anyway",
                        color = MaterialTheme.colorScheme.error,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") }
        },
    )
}

private enum class AgentTab(val label: String) { TERMINAL("Terminal"), CHANGES("Changes"), NOTES("Notes") }

/** Keys agent TUIs ask for that a phone keyboard can't type, as in the phone web UI. */
private val QUICK_KEYS = listOf(
    "Enter" to "\r",
    "Esc" to "\u001b",
    "→" to "\u001b[C",
    "↑" to "\u001b[A",
    "↓" to "\u001b[B",
    "/" to "/",
    "Ctrl+C" to "\u0003",
    "Ctrl+D" to "\u0004",
    "Clear" to "\u000c",
)

@Composable
private fun TerminalText(
    lines: List<List<StyledSpan>>,
    cols: Int,
    modifier: Modifier,
    alwaysFollow: Boolean,
    fitToView: Boolean,
    onViewSize: (cols: Int, rows: Int) -> Unit,
    onZoomedChange: (Boolean) -> Unit = {},
    /** Room kept under the newest line for a pill floating over the terminal's bottom. */
    bottomInset: Dp = 0.dp,
) {
    // The terminal follows the active look, as it does on the desktop: its own ANSI
    // set over the look's panel background.
    val look = AppTheme.palette
    val palette = remember(look) { TerminalPalette.forLook(look) }
    // A lazy list lays out only the lines on screen; history lines keep their style runs between
    // frames, so a spinner repainting one row no longer rebuilds thousands of lines.
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var follow by remember { mutableStateOf(true) }
    val isNearBottom by remember { derivedStateOf { !list.canScrollForward } }
    var hasNewOutputWhileScrolled by remember { mutableStateOf(false) }
    // Pinching magnifies the whole terminal, as a picture would, rather than reflowing its text.
    var zoom by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    // A zoomed terminal pans sideways under one finger, so the task pager must not swipe meanwhile.
    val zoomed by remember { derivedStateOf { zoom > 1f } }
    val currentOnZoomedChange by rememberUpdatedState(onZoomedChange)
    LaunchedEffect(zoomed) { currentOnZoomedChange(zoomed) }
    DisposableEffect(Unit) { onDispose { currentOnZoomedChange(false) } }

    // Follow output only while parked at the bottom, decided where each scroll ends. Deciding at
    // the start instead kept follow on for a scroll that began at the bottom (the usual case), so
    // an agent that redraws constantly (Claude's spinner) snapped the view back on its next frame.
    // With "Always scroll to latest output" on, a scroll only holds the view while the finger is down.
    LaunchedEffect(list.isScrollInProgress, alwaysFollow) {
        if (!list.isScrollInProgress) {
            follow = alwaysFollow || isNearBottom
            if (follow) hasNewOutputWhileScrolled = false
        }
    }

    LaunchedEffect(lines) {
        if (follow && !list.isScrollInProgress) {
            withFrameNanos {}
            // A scroll may have started or ended during that frame.
            if (follow && !list.isScrollInProgress && lines.isNotEmpty()) list.scrollToItem(lines.lastIndex)
        } else if (!isNearBottom) {
            hasNewOutputWhileScrolled = true
        }
    }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .background(Color(palette.background))
            .clipToBounds()
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    do {
                        // The Initial pass runs before the list's own scrolling, so two fingers
                        // zoom and pan here while one finger still scrolls the history.
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val pressed = event.changes.filter { it.pressed }
                        if (pressed.size >= 2) {
                            val next = (zoom * event.calculateZoom()).coerceIn(1f, MAX_TERMINAL_ZOOM)
                            val centroid = event.calculateCentroid(useCurrent = true)
                            pan = clampPan(
                                centroid - (centroid - pan) * (next / zoom) + event.calculatePan(),
                                next,
                                size.width.toFloat(),
                                size.height.toFloat(),
                            )
                            zoom = next
                            event.changes.forEach { it.consume() }
                        } else if (pressed.size == 1 && zoom > 1f) {
                            // The list only scrolls vertically: one finger pans sideways too.
                            val dx = pressed[0].positionChange().x
                            pan = clampPan(pan + Offset(dx, 0f), zoom, size.width.toFloat(), size.height.toFloat())
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = {
                    zoom = 1f
                    pan = Offset.Zero
                })
            },
    ) {
        // The PTY keeps the desktop's size, which rarely matches the phone. Size the font so its
        // columns span the screen width (within readable bounds), wrap lines still too wide at the
        // smallest font, and anchor a screen shorter than the view to the bottom, next to the
        // reply box, as a terminal window would.
        val density = LocalDensity.current
        val measurer = rememberTextMeasurer()
        val paddingPx = with(density) { (TERMINAL_PADDING_H * 2).roundToPx() }
        val textWidthPx = constraints.maxWidth - paddingPx
        val charPxAt10 = remember(measurer) {
            measurer.measure("0".repeat(10), TextStyle(fontFamily = FontFamily.Monospace, fontSize = 10.sp)).size.width / 10f
        }
        val autoFont = (10f * textWidthPx / (cols.coerceAtLeast(1) * charPxAt10)).coerceIn(8f, 14f).sp
        val phoneFont = TERMINAL_FONT
        val fontSize = if (fitToView) phoneFont else autoFont

        val viewPaddingPx = with(density) { 16.dp.roundToPx() }
        val viewHeightPx = constraints.maxHeight
        // A smaller view (the keyboard opening, leaving expanded mode) must not reveal an empty band.
        LaunchedEffect(constraints.maxWidth, constraints.maxHeight) {
            pan = clampPan(pan, zoom, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
        }
        LaunchedEffect(textWidthPx, viewHeightPx, phoneFont, density) {
            val probe = measurer.measure(
                "0".repeat(10),
                TextStyle(fontFamily = FontFamily.Monospace, fontSize = phoneFont, lineHeight = phoneFont * 1.27f),
            )
            val viewCols = (textWidthPx / (probe.size.width / 10f)).toInt()
            val viewRows = ((viewHeightPx - viewPaddingPx) / probe.size.height.toFloat()).toInt()
            if (viewCols > 0 && viewRows > 0) onViewSize(viewCols.coerceAtMost(500), viewRows.coerceAtMost(500))
        }

        LazyColumn(
            state = list,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer {
                    transformOrigin = TransformOrigin(0f, 0f)
                    scaleX = zoom
                    scaleY = zoom
                    translationX = pan.x
                    translationY = pan.y
                },
            contentPadding = PaddingValues(
                start = TERMINAL_PADDING_H,
                end = TERMINAL_PADDING_H,
                top = 8.dp,
                bottom = 8.dp + bottomInset,
            ),
            verticalArrangement = Arrangement.Bottom,
        ) {
            items(lines.size) { i ->
                val line = lines[i]
                val text = remember(line, palette) { terminalLine(line, palette) }
                Text(
                    text = text,
                    color = Color(palette.foreground),
                    fontFamily = FontFamily.Monospace,
                    fontSize = fontSize,
                    lineHeight = fontSize * 1.27f,
                )
            }
        }

        // Vertical scrollbar indicator along the right edge
        TerminalVerticalScrollbar(
            list = list,
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .fillMaxHeight()
                .padding(end = 2.dp, top = 4.dp, bottom = 4.dp),
        )

        if (zoomed) {
            ZoomResetPill(
                zoom = { zoom },
                onClick = {
                    zoom = 1f
                    pan = Offset.Zero
                },
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 8.dp)
                    .semantics { contentDescription = "Reset terminal zoom" },
            )
        }

        // Floating jump-to-bottom / new-output pill button
        AnimatedVisibility(
            visible = !isNearBottom,
            enter = fadeIn(tween(180)) + slideInVertically(tween(200)) { it / 2 },
            exit = fadeOut(tween(150)) + slideOutVertically(tween(180)) { it / 2 },
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 16.dp, bottom = 12.dp),
        ) {
            val jumpInteractionSource = remember { MutableInteractionSource() }
            val isPressed by jumpInteractionSource.collectIsPressedAsState()
            val scale by animateFloatAsState(
                targetValue = if (isPressed) 0.94f else 1f,
                animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow),
                label = "jumpToBottomScale",
            )
            Surface(
                onClick = {
                    follow = true
                    hasNewOutputWhileScrolled = false
                    scope.launch { if (lines.isNotEmpty()) list.animateScrollToItem(lines.lastIndex) }
                },
                interactionSource = jumpInteractionSource,
                shape = RoundedCornerShape(20.dp),
                color = if (hasNewOutputWhileScrolled) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                border = BorderStroke(1.dp, if (hasNewOutputWhileScrolled) MaterialTheme.colorScheme.primary else AppTheme.extra.border),
                shadowElevation = 6.dp,
                modifier = Modifier.graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                },
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = if (hasNewOutputWhileScrolled) "↓ New output" else "↓ Latest",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold,
                        color = if (hasNewOutputWhileScrolled) MaterialTheme.colorScheme.onPrimaryContainer else AppTheme.extra.textPrimary,
                    )
                }
            }
        }
    }
}

private val TERMINAL_PADDING_H = 12.dp
private val TERMINAL_FONT = 11.sp
private const val MAX_TERMINAL_ZOOM = 4f

/**
 * Keeps a terminal magnified by [zoom] (from its top-left corner) covering its whole view, so a pan
 * never reveals empty space past an edge.
 */
internal fun clampPan(pan: Offset, zoom: Float, width: Float, height: Float): Offset = Offset(
    pan.x.coerceIn(width * (1f - zoom), 0f),
    pan.y.coerceIn(height * (1f - zoom), 0f),
)

/** Shows the pinch zoom and resets it; reads [zoom] here, so a pinch recomposes only this pill. */
@Composable
private fun ZoomResetPill(zoom: () -> Float, onClick: () -> Unit, modifier: Modifier = Modifier) {
    TerminalPill("${(zoom() * 100).roundToInt()}% · Reset", onClick, modifier)
}

/** A small floating button over the terminal, quiet like the rest of the routine controls. */
@Composable
private fun TerminalPill(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.dp, AppTheme.extra.border),
        shadowElevation = 6.dp,
        modifier = modifier,
    ) {
        Text(
            text,
            Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = AppTheme.extra.textPrimary,
        )
    }
}

@Composable
private fun TerminalVerticalScrollbar(
    list: LazyListState,
    modifier: Modifier = Modifier,
) {
    val info = list.layoutInfo
    val total = info.totalItemsCount
    val visible = info.visibleItemsInfo.size
    if (total == 0 || visible >= total) return
    BoxWithConstraints(modifier.width(4.dp)) {
        val totalHeight = maxHeight
        val thumbHeightDp = totalHeight * (visible.toFloat() / total).coerceIn(0.08f, 0.9f)
        val scrollRatio = (list.firstVisibleItemIndex.toFloat() / (total - visible)).coerceIn(0f, 1f)
        Box(
            Modifier
                .offset(y = (totalHeight - thumbHeightDp) * scrollRatio)
                .fillMaxWidth()
                .height(thumbHeightDp)
                .clip(RoundedCornerShape(2.dp))
                .background(
                    if (list.isScrollInProgress) AppTheme.extra.textPrimary.copy(alpha = 0.55f)
                    else AppTheme.extra.textMuted.copy(alpha = 0.28f)
                ),
        )
    }
}

private fun terminalLine(line: List<StyledSpan>, palette: TerminalPalette) =
    buildAnnotatedString {
        line.forEach { span ->
            if (span.style == CellStyle.DEFAULT) {
                append(span.text)
                return@forEach
            }
            val s = palette.resolve(span.style)
            withStyle(
                SpanStyle(
                    color = Color(s.foreground),
                    background = s.background?.let(::Color) ?: Color.Unspecified,
                    fontWeight = if (s.bold) FontWeight.Bold else null,
                    fontStyle = if (s.italic) FontStyle.Italic else null,
                    textDecoration = when {
                        s.underline && s.strike -> TextDecoration.combine(
                            listOf(TextDecoration.Underline, TextDecoration.LineThrough),
                        )
                        s.underline -> TextDecoration.Underline
                        s.strike -> TextDecoration.LineThrough
                        else -> null
                    },
                ),
            ) { append(span.text) }
        }
    }

@Composable
private fun QuickKeyButton(
    busy: Boolean,
    onSend: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    val interactionSource = remember { MutableInteractionSource() }
    val isPressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (isPressed) 0.92f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label = "quickKeyScale",
    )
    OutlinedButton(
        onClick = {
            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            onSend()
        },
        enabled = !busy,
        shape = MaterialTheme.shapes.small,
        border = BorderStroke(1.dp, AppTheme.extra.border),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
            contentColor = AppTheme.extra.textPrimary,
        ),
        interactionSource = interactionSource,
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
        modifier = Modifier.graphicsLayer {
            scaleX = scale
            scaleY = scale
        },
        content = content,
    )
}

/** An arrow quick key ([Icons.Filled.KeyboardArrowUp] and friends), drawn larger than key text. */
private fun arrowKeyFor(label: String): Pair<ImageVector, String>? = when (label) {
    "↑" -> Icons.Filled.KeyboardArrowUp to "Arrow up"
    "↓" -> Icons.Filled.KeyboardArrowDown to "Arrow down"
    "→" -> Icons.Filled.KeyboardArrowRight to "Arrow right"
    else -> null
}

@Composable
private fun ReplyBox(
    agentId: String,
    compact: Boolean = false,
    working: Boolean = false,
    promptHistory: PromptHistoryStore? = null,
    needsInput: Boolean = false,
    sendsLineBreaksAsSpaces: Boolean = false,
    send: suspend (text: String, shell: Boolean) -> Unit,
    sendKey: suspend (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val haptic = LocalHapticFeedback.current
    // The TextFieldValue overload: the String one skips an edit that repeats one it was refused,
    // so a second `!` (re-entering shell mode, or `!!`) would be dropped.
    var field by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue()) }
    val draft = field.text
    fun setDraft(text: String) {
        field = TextFieldValue(text, TextRange(text.length))
    }
    // As in the desktop TUI and the phone web UI, a `!` typed into an empty reply switches to the
    // agent's shell: the desktop types the `!` as its own keystroke before the command.
    var shellMode by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showHistory by remember { mutableStateOf(false) }
    fun run(action: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            try {
                action()
            } catch (e: IOException) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }
    Surface(
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, AppTheme.extra.border),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!compact) Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                QUICK_KEYS.forEach { (label, data) ->
                    val arrow = arrowKeyFor(label)
                    QuickKeyButton(busy = busy, onSend = { run { sendKey(data) } }) {
                        if (arrow != null) {
                            Icon(arrow.first, contentDescription = arrow.second, modifier = Modifier.size(20.dp))
                        } else {
                            Text(label, fontFamily = FontFamily.Monospace, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
            AnimatedVisibility(
                visible = error != null,
                enter = expandVertically() + fadeIn(),
                exit = shrinkVertically() + fadeOut(),
            ) {
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            if (sendsLineBreaksAsSpaces && '\n' in draft) {
                Text(
                    "This terminal sends line breaks as spaces.",
                    color = AppTheme.extra.textMuted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(
                    value = field,
                    onValueChange = {
                        // Only a typed bang switches; a pasted or dictated draft stays text.
                        if (it.text == "!" && field.text.isEmpty() && !shellMode) {
                            shellMode = true
                            field = TextFieldValue()
                        } else {
                            field = it
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = {
                        Text(
                            when {
                                shellMode -> "Shell command"
                                needsInput -> "Reply to agent"
                                else -> "Message agent"
                            },
                            color = AppTheme.extra.textSubtle,
                        )
                    },
                    leadingIcon = if (shellMode) {
                        {
                            TextButton(
                                onClick = { shellMode = false },
                                enabled = !busy,
                                modifier = Modifier.semantics { contentDescription = "Shell command mode. Tap to message the agent instead." },
                            ) { Text("!", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold) }
                        }
                    } else null,
                    minLines = if (compact) 1 else 2,
                    maxLines = if (compact) 3 else 6,
                    enabled = !busy,
                    shape = MaterialTheme.shapes.large,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = AppTheme.extra.inputBg,
                        unfocusedContainerColor = AppTheme.extra.inputBg,
                        focusedBorderColor = MaterialTheme.colorScheme.primary,
                        unfocusedBorderColor = AppTheme.extra.border,
                    ),
                )
                Row(
                    modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    VoiceInputButton(
                        enabled = !busy,
                        modifier = Modifier.fillMaxHeight(),
                    ) { setDraft(appendToDraft(draft, it)) }
                    if (promptHistory != null) {
                        OutlinedButton(
                            onClick = { showHistory = true },
                            enabled = !busy && promptHistory.history(agentId).isNotEmpty(),
                            shape = MaterialTheme.shapes.large,
                            modifier = Modifier.fillMaxHeight(),
                        ) {
                            Icon(Icons.Filled.History, contentDescription = "Recent messages")
                        }
                    }
                    if (working && draft.isBlank()) {
                        OutlinedButton(
                            // Interrupts the running command, like the Ctrl+C quick key.
                            onClick = { run { sendKey(3.toChar().toString()) } },
                            enabled = !busy,
                            shape = MaterialTheme.shapes.large,
                            modifier = Modifier.fillMaxHeight(),
                        ) { Icon(Icons.Filled.Stop, contentDescription = "Stop") }
                    } else {
                        val sendInteraction = remember { MutableInteractionSource() }
                        val sendPressed by sendInteraction.collectIsPressedAsState()
                        val sendScale by animateFloatAsState(
                            targetValue = if (sendPressed) 0.94f else 1f,
                            animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
                            label = "sendButtonScale",
                        )
                        Button(
                            enabled = draft.isNotBlank() && !busy,
                            shape = MaterialTheme.shapes.large,
                            interactionSource = sendInteraction,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.primary,
                                contentColor = MaterialTheme.colorScheme.onPrimary,
                            ),
                            modifier = Modifier
                                .fillMaxHeight()
                                .graphicsLayer {
                                    scaleX = sendScale
                                    scaleY = sendScale
                                },
                            onClick = {
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                val text = draft
                                val shell = shellMode
                                run {
                                    send(text, shell)
                                    promptHistory?.record(agentId, text)
                                    setDraft("")
                                    shellMode = false
                                }
                            },
                        ) { Text("Send", fontWeight = FontWeight.Bold) }
                    }
                }
            }
            if (showHistory) {
                val history = remember(showHistory) { promptHistory?.history(agentId).orEmpty() }
                PromptHistoryDialog(
                    history = history,
                    onPick = {
                        setDraft(appendToDraft(draft, it))
                        showHistory = false
                    },
                    onDismiss = { showHistory = false },
                )
            }
        }
    }
}

fun statusLabel(state: ConnectionState) = when (state.status) {
    ConnectionStatus.CONNECTED -> if (state.canControl) "Connected" else "Connected, view only"
    ConnectionStatus.CONNECTING -> "Connecting…"
    ConnectionStatus.WAITING_FOR_VPN -> "Waiting for VPN…"
    ConnectionStatus.DISCONNECTED -> "Offline"
}

internal fun agentStatusLabel(agent: RemoteAgent): String {
    if (agent.collapsed) return "Minimized"
    if (!agent.running) return agent.exitCode?.let { "Exited ($it)" } ?: "Exited"
    return when (agent.attention) {
        "needs_input" -> "Needs input"
        "active" -> "Working"
        "shell_busy" -> "Running command"
        "error" -> "Error"
        "ready" -> "Ready"
        "review" -> "Review"
        else -> "Idle"
    }
}
