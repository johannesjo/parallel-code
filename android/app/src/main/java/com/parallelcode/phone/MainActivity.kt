package com.parallelcode.phone
import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.snapshotFlow
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.Modifier
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Which agent changes notify, from Settings (see [AgentWatchService]). */
data class NotificationPrefs(
    val enabled: Boolean,
    val needsInput: Boolean,
    val errors: Boolean,
    val finished: Boolean,
)

class PhoneViewModel(application: Application) : AndroidViewModel(application) {
    private val phoneApp = application as PhoneApplication
    val client = phoneApp.client
    val settingsStore = phoneApp.settings
    val promptHistory = phoneApp.promptHistory

    /** An agent to open, from a tapped notification. */
    val openAgentRequest = MutableStateFlow<String?>(null)

    private val _notifications = MutableStateFlow(readNotificationPrefs())
    val notifications: StateFlow<NotificationPrefs> = _notifications.asStateFlow()

    private fun readNotificationPrefs() = NotificationPrefs(
        enabled = settingsStore.notificationsEnabled,
        needsInput = settingsStore.notifyNeedsInput,
        errors = settingsStore.notifyErrors,
        finished = settingsStore.notifyFinished,
    )

    fun setNotifications(prefs: NotificationPrefs) {
        settingsStore.notificationsEnabled = prefs.enabled
        settingsStore.notifyNeedsInput = prefs.needsInput
        settingsStore.notifyErrors = prefs.errors
        settingsStore.notifyFinished = prefs.finished
        _notifications.value = prefs
        AgentWatchService.sync(getApplication())
    }
    private val _keepScreenOn = MutableStateFlow(settingsStore.keepScreenOn)
    val keepScreenOn: StateFlow<Boolean> = _keepScreenOn.asStateFlow()

    private val _waitForVpn = MutableStateFlow(settingsStore.waitForVpn)
    val waitForVpn: StateFlow<Boolean> = _waitForVpn.asStateFlow()

    fun setWaitForVpn(value: Boolean) {
        settingsStore.waitForVpn = value
        _waitForVpn.value = value
        client.onVpnPolicyChanged()
    }

    private val _homeWifiSsid = MutableStateFlow(settingsStore.homeWifiSsid)
    val homeWifiSsid: StateFlow<String?> = _homeWifiSsid.asStateFlow()
    val currentWifiSsid: StateFlow<String?> = phoneApp.networkMonitor.wifiSsid

    fun setHomeWifiSsid(value: String?) {
        settingsStore.homeWifiSsid = value
        _homeWifiSsid.value = settingsStore.homeWifiSsid
        client.onVpnPolicyChanged()
    }

    /** Reads the Wi-Fi name again, after location permission is granted or the app returns to the screen. */
    fun refreshWifi() = phoneApp.networkMonitor.refreshWifi()

    private val _keepScreenOnOnlyWhenActive = MutableStateFlow(settingsStore.keepScreenOnOnlyWhenActive)
    val keepScreenOnOnlyWhenActive: StateFlow<Boolean> = _keepScreenOnOnlyWhenActive.asStateFlow()

    private val _themeMode = MutableStateFlow(settingsStore.themeMode)
    val themeMode: StateFlow<String> = _themeMode.asStateFlow()

    private val _darkThemePreset = MutableStateFlow(settingsStore.darkThemePreset)
    val darkThemePreset: StateFlow<String> = _darkThemePreset.asStateFlow()

    private val _lightThemePreset = MutableStateFlow(settingsStore.lightThemePreset)
    val lightThemePreset: StateFlow<String> = _lightThemePreset.asStateFlow()

    private val _showMinimizedTasks = MutableStateFlow(settingsStore.showMinimizedTasks)
    val showMinimizedTasks: StateFlow<Boolean> = _showMinimizedTasks.asStateFlow()

    private val _quickReplies = MutableStateFlow(settingsStore.quickReplies)
    val quickReplies: StateFlow<List<String>> = _quickReplies.asStateFlow()

    fun setQuickReplies(value: List<String>) {
        settingsStore.quickReplies = value
        _quickReplies.value = settingsStore.quickReplies
    }

    private val _sendQuickReplies = MutableStateFlow(settingsStore.sendQuickReplies)
    val sendQuickReplies: StateFlow<Boolean> = _sendQuickReplies.asStateFlow()

    fun setSendQuickReplies(value: Boolean) {
        settingsStore.sendQuickReplies = value
        _sendQuickReplies.value = value
    }

    private val _fitTerminalToPhone = MutableStateFlow(settingsStore.fitTerminalToPhone)
    val fitTerminalToPhone: StateFlow<Boolean> = _fitTerminalToPhone.asStateFlow()

    fun setFitTerminalToPhone(value: Boolean) {
        settingsStore.fitTerminalToPhone = value
        _fitTerminalToPhone.value = value
    }

    private val _alwaysFollowOutput = MutableStateFlow(settingsStore.alwaysFollowOutput)
    val alwaysFollowOutput: StateFlow<Boolean> = _alwaysFollowOutput.asStateFlow()

    fun setAlwaysFollowOutput(value: Boolean) {
        settingsStore.alwaysFollowOutput = value
        _alwaysFollowOutput.value = value
    }

    fun setKeepScreenOn(value: Boolean) {
        settingsStore.keepScreenOn = value
        _keepScreenOn.value = value
    }

    fun setKeepScreenOnOnlyWhenActive(value: Boolean) {
        settingsStore.keepScreenOnOnlyWhenActive = value
        _keepScreenOnOnlyWhenActive.value = value
    }

    fun setThemeMode(value: String) {
        settingsStore.themeMode = value
        _themeMode.value = value
    }

    fun setDarkThemePreset(value: String) {
        settingsStore.darkThemePreset = value
        _darkThemePreset.value = settingsStore.darkThemePreset
    }

    fun setLightThemePreset(value: String) {
        settingsStore.lightThemePreset = value
        _lightThemePreset.value = settingsStore.lightThemePreset
    }

    fun setShowMinimizedTasks(value: Boolean) {
        settingsStore.showMinimizedTasks = value
        _showMinimizedTasks.value = value
    }

    private val _widgetTransparency = MutableStateFlow(settingsStore.widgetTransparency)
    val widgetTransparency: StateFlow<Int> = _widgetTransparency.asStateFlow()

    fun setWidgetTransparency(value: Int) {
        settingsStore.widgetTransparency = value
        _widgetTransparency.value = settingsStore.widgetTransparency
        // The widget draws on its own schedule, so push the new card to it right away.
        AgentWidget.refresh(getApplication())
    }

    private val _widgetPalette = MutableStateFlow(settingsStore.widgetPalette)
    val widgetPalette: StateFlow<String> = _widgetPalette.asStateFlow()

    fun setWidgetPalette(value: String) {
        settingsStore.widgetPalette = value
        _widgetPalette.value = settingsStore.widgetPalette
        AgentWidget.refresh(getApplication())
    }
}

class MainActivity : ComponentActivity() {
    private val model: PhoneViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openAgentFrom(intent)
        enableEdgeToEdge()
        setContent {
            val keepScreenOn by model.keepScreenOn.collectAsState()
            val keepScreenOnOnlyActive by model.keepScreenOnOnlyWhenActive.collectAsState()
            val agents by model.client.agents.collectAsState()
            val themeMode by model.themeMode.collectAsState()
            val darkThemePreset by model.darkThemePreset.collectAsState()
            val lightThemePreset by model.lightThemePreset.collectAsState()

            val hasActiveAgent = agents.any { it.running && (it.attention == "active" || it.attention == "shell_busy") }
            val shouldKeepAwake = keepScreenOn && (!keepScreenOnOnlyActive || hasActiveAgent)

            DisposableEffect(shouldKeepAwake) {
                if (shouldKeepAwake) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
                onDispose {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }

            val darkTheme = when (themeMode) {
                SettingsStore.THEME_DARK -> true
                SettingsStore.THEME_LIGHT -> false
                else -> isSystemInDarkTheme()
            }

            val palette = resolveLookPalette(
                darkPresetId = darkThemePreset,
                lightPresetId = lightThemePreset,
                darkTheme = darkTheme,
            )

            // enableEdgeToEdge() in onCreate follows the system tone, but a look can
            // differ from it (Always light on a dark phone), so the system bar icon
            // tint is re-applied for the palette actually on screen.
            val view = LocalView.current
            if (!view.isInEditMode) {
                SideEffect {
                    val window = (view.context as? Activity)?.window ?: return@SideEffect
                    WindowCompat.getInsetsController(window, view).apply {
                        isAppearanceLightStatusBars = !palette.dark
                        isAppearanceLightNavigationBars = !palette.dark
                    }
                }
            }

            ParallelCodeTheme(palette = palette) {
                PhoneApp(model)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openAgentFrom(intent)
    }

    private fun openAgentFrom(intent: Intent?) {
        intent?.getStringExtra(EXTRA_AGENT_ID)?.let { model.openAgentRequest.value = it }
    }

    // The socket stays open while the app is visible, like the phone web UI's tab, and in the
    // background only while agent notifications are on.
    override fun onStart() {
        super.onStart()
        (application as PhoneApplication).inForeground = true
        // Android hides the Wi-Fi name from apps in the background, so a name read while only the
        // notification service was running is blank. Read it again now that the app is visible.
        model.refreshWifi()
        model.client.start(HOLDER)
        model.client.resumeViewSize()
        AgentWatchService.sync(this)
        (application as PhoneApplication).updates.checkIfDue()
    }

    override fun onStop() {
        model.client.pauseViewSize()
        model.client.stop(HOLDER)
        (application as PhoneApplication).inForeground = false
        super.onStop()
    }

    companion object {
        const val EXTRA_AGENT_ID = "agentId"
        private const val HOLDER = "app"
    }
}

private sealed interface Screen {
    data object Agents : Screen
    data object Pair : Screen
    data object NewTask : Screen
    data object Settings : Screen
    data class Agent(val agentId: String) : Screen
}

@Composable
private fun PhoneApp(model: PhoneViewModel) {
    val state by model.client.state.collectAsState()
    val agents by model.client.agents.collectAsState()
    var screenKey by rememberSaveable { mutableStateOf("agents") }
    // Held above the screen switch, so the list's search and filter survive opening a task.
    var taskSearch by rememberSaveable { mutableStateOf("") }
    var taskFilterKey by rememberSaveable { mutableStateOf(TaskFilter.ALL.key) }
    val screen = when {
        screenKey == "pair" -> Screen.Pair
        screenKey == "new-task" -> Screen.NewTask
        screenKey == "settings" -> Screen.Settings
        screenKey.startsWith("agent:") -> Screen.Agent(screenKey.removePrefix("agent:"))
        else -> Screen.Agents
    }
    val link = state.link
    val openAgentRequest by model.openAgentRequest.collectAsState()
    val haptic = LocalHapticFeedback.current
    LaunchedEffect(openAgentRequest) {
        val agentId = openAgentRequest ?: return@LaunchedEffect
        haptic.performHapticFeedback(HapticFeedbackType.Confirm)
        screenKey = "agent:$agentId"
        model.openAgentRequest.value = null
    }

    val computers by model.client.computers.collectAsState()
    if (link == null) {
        ConnectScreen(
            expired = state.linkExpired,
            onLink = { model.client.link(it) },
            saved = computers,
            onSelectSaved = { model.client.switchTo(it) },
        )
        return
    }
    if (screenKey == "add-computer") {
        BackHandler { screenKey = "settings" }
        ConnectScreen(
            expired = false,
            onLink = {
                model.client.link(it)
                screenKey = "agents"
            },
            onCancel = { screenKey = "settings" },
        )
        return
    }
    // Predictive back: the screen shrinks and slides with the swipe, and only leaves on release.
    var backProgress by remember { mutableFloatStateOf(0f) }
    if (screen != Screen.Agents) {
        PredictiveBackHandler { events ->
            try {
                events.collect { backProgress = it.progress }
                screenKey = "agents"
            } finally {
                backProgress = 0f
            }
        }
    }
    AnimatedContent(
        targetState = screen,
        modifier = Modifier.graphicsLayer {
            val p = backProgress
            scaleX = 1f - 0.08f * p
            scaleY = 1f - 0.08f * p
            translationX = p * 48.dp.toPx()
            alpha = 1f - 0.25f * p
        },
        transitionSpec = {
            if (initialState == Screen.Agents) {
                (slideInHorizontally(animationSpec = tween(280)) { width -> (width * 0.15f).toInt() } + fadeIn(tween(250)))
                    .togetherWith(slideOutHorizontally(animationSpec = tween(240)) { width -> -(width * 0.15f).toInt() } + fadeOut(tween(200)))
            } else if (targetState == Screen.Agents) {
                (slideInHorizontally(animationSpec = tween(280)) { width -> -(width * 0.15f).toInt() } + fadeIn(tween(250)))
                    .togetherWith(slideOutHorizontally(animationSpec = tween(240)) { width -> (width * 0.15f).toInt() } + fadeOut(tween(200)))
            } else {
                fadeIn(tween(200)).togetherWith(fadeOut(tween(200)))
            }
        },
        // Swiping between tasks changes which agent is open without leaving the task pager.
        contentKey = { if (it is Screen.Agent) "agent" else it },
        label = "screenTransition",
    ) { currentScreen ->
        when (currentScreen) {
            Screen.Agents -> {
                val showMinimizedTasks by model.showMinimizedTasks.collectAsState()
                AgentsScreen(
                    client = model.client,
                    host = link.baseUrl,
                    state = state,
                    agents = agents,
                    showMinimizedTasks = showMinimizedTasks,
                    onOpen = { screenKey = "agent:${it.agentId}" },
                    onPair = { screenKey = "pair" },
                    onNewTask = { screenKey = "new-task" },
                    onSettings = { screenKey = "settings" },
                    computers = computers,
                    onSwitchComputer = { model.client.switchTo(it) },
                    search = taskSearch,
                    onSearch = { taskSearch = it },
                    filter = TaskFilter.fromKey(taskFilterKey),
                    onFilter = { taskFilterKey = it.key },
                )
            }
            Screen.Settings -> {
                val keepScreenOn by model.keepScreenOn.collectAsState()
                val keepScreenOnOnlyActive by model.keepScreenOnOnlyWhenActive.collectAsState()
                val themeMode by model.themeMode.collectAsState()
                val darkThemePreset by model.darkThemePreset.collectAsState()
                val lightThemePreset by model.lightThemePreset.collectAsState()
                val showMinimizedTasks by model.showMinimizedTasks.collectAsState()
                val latencyMs by model.client.latencyMs.collectAsState()
                val alwaysFollowOutput by model.alwaysFollowOutput.collectAsState()
                val notifications by model.notifications.collectAsState()
                val quickReplies by model.quickReplies.collectAsState()
                val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
                    model.setNotifications(notifications.copy(enabled = granted))
                }
                val context = LocalContext.current
                // Agent notifications run in the background, where Android hides the Wi-Fi name unless
                // location is allowed all the time. Android 10+ asks for that after the usual location
                // access, and Android 11+ shows it as a settings page.
                val backgroundLocationPermission = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission(),
                ) { model.refreshWifi() }
                val requestBackgroundLocationIfNeeded = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) !=
                        PackageManager.PERMISSION_GRANTED
                    ) {
                        backgroundLocationPermission.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                    }
                }
                val locationPermission = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestMultiplePermissions(),
                ) { granted ->
                    model.refreshWifi()
                    if (granted[Manifest.permission.ACCESS_FINE_LOCATION] == true) requestBackgroundLocationIfNeeded()
                }
                // Asks for location access; true while the Wi-Fi name is still hidden even on screen.
                val requestLocationIfNeeded = {
                    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
                        PackageManager.PERMISSION_GRANTED
                    if (!granted) {
                        locationPermission.launch(
                            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                        )
                    } else {
                        requestBackgroundLocationIfNeeded()
                    }
                    !granted
                }
                val currentWifiSsid by model.currentWifiSsid.collectAsState()
                SettingsScreen(
                    keepScreenOn = keepScreenOn,
                    onKeepScreenOnChange = model::setKeepScreenOn,
                    keepScreenOnOnlyActive = keepScreenOnOnlyActive,
                    onKeepScreenOnOnlyActiveChange = model::setKeepScreenOnOnlyWhenActive,
                    themeMode = themeMode,
                    onThemeModeChange = model::setThemeMode,
                    darkThemePreset = darkThemePreset,
                    onDarkThemePresetChange = model::setDarkThemePreset,
                    lightThemePreset = lightThemePreset,
                    onLightThemePresetChange = model::setLightThemePreset,
                    showMinimizedTasks = showMinimizedTasks,
                    onShowMinimizedTasksChange = model::setShowMinimizedTasks,
                    alwaysFollowOutput = alwaysFollowOutput,
                    onAlwaysFollowOutputChange = model::setAlwaysFollowOutput,
                    fitTerminalToPhone = model.fitTerminalToPhone.collectAsState().value,
                    onFitTerminalToPhoneChange = model::setFitTerminalToPhone,
                    widgetTransparency = model.widgetTransparency.collectAsState().value,
                    onWidgetTransparencyChange = model::setWidgetTransparency,
                    widgetPalette = model.widgetPalette.collectAsState().value,
                    onWidgetPaletteChange = model::setWidgetPalette,
                    quickReplies = quickReplies,
                    onQuickRepliesChange = model::setQuickReplies,
                    sendQuickReplies = model.sendQuickReplies.collectAsState().value,
                    onSendQuickRepliesChange = model::setSendQuickReplies,
                    notifications = notifications,
                    onNotificationsChange = { prefs ->
                        val needsPermission = prefs.enabled && !notifications.enabled &&
                            Build.VERSION.SDK_INT >= 33 &&
                            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                            PackageManager.PERMISSION_GRANTED
                        if (needsPermission) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        else model.setNotifications(prefs)
                    },
                    waitForVpn = model.waitForVpn.collectAsState().value,
                    onWaitForVpnChange = model::setWaitForVpn,
                    homeWifiSsid = model.homeWifiSsid.collectAsState().value,
                    onHomeWifiSsidChange = { ssid ->
                        model.setHomeWifiSsid(ssid)
                        if (!ssid.isNullOrBlank()) requestLocationIfNeeded()
                    },
                    currentWifiSsid = currentWifiSsid,
                    onUseCurrentWifi = {
                        val ssid = currentWifiSsid
                        if (!requestLocationIfNeeded() && ssid != null) model.setHomeWifiSsid(ssid)
                    },
                    latencyMs = latencyMs,
                    state = state,
                    computers = computers,
                    onSwitchComputer = {
                        model.client.switchTo(it)
                        screenKey = "agents"
                    },
                    onRenameComputer = { url, alias -> model.client.rename(url, alias) },
                    onForgetComputer = { model.client.forget(it) },
                    onAddComputer = { screenKey = "add-computer" },
                    onPair = { screenKey = "pair" },
                    onForget = {
                        model.client.forget()
                        AgentWatchService.sync(context)
                        screenKey = "agents"
                    },
                    onBack = { screenKey = "agents" },
                )
            }
            Screen.Pair -> PairScreen(
                pair = model.client::pair,
                onDone = { screenKey = "agents" },
            )
            Screen.NewTask -> NewTaskScreen(
                client = model.client,
                onDone = { screenKey = "agents" },
                onNeedsPairing = { screenKey = "pair" },
            )
            is Screen.Agent -> {
                val alwaysFollowOutput by model.alwaysFollowOutput.collectAsState()
                val quickReplies by model.quickReplies.collectAsState()
                val sendQuickReplies by model.sendQuickReplies.collectAsState()
                val fitTerminalToPhone by model.fitTerminalToPhone.collectAsState()
                // The tasks in the order the list shows them: swipe sideways to move between them.
                val pages = remember(agents) { taskListOrder(agents) }
                val openIndex = pages.indexOfFirst { it.agentId == currentScreen.agentId }
                // The task whose terminal is pinch-zoomed; its sideways pans must not turn the page.
                var zoomedAgentId by remember { mutableStateOf<String?>(null) }

                @Composable
                fun Task(agentId: String, active: Boolean, pageLabel: String?) {
                    val agent = agents.firstOrNull { it.agentId == agentId }
                    if (agent?.isChat == true) {
                        ChatScreen(
                            agent = agent,
                            agentId = agentId,
                            state = state,
                            client = model.client,
                            quickReplies = quickReplies,
                            sendQuickReplies = sendQuickReplies,
                            promptHistory = model.promptHistory,
                            pageLabel = pageLabel,
                            onBack = { screenKey = "agents" },
                            onPair = { screenKey = "pair" },
                        )
                    } else AgentScreen(
                        agent = agent,
                        agentId = agentId,
                        state = state,
                        client = model.client,
                        alwaysFollowOutput = alwaysFollowOutput,
                        fitTerminalToPhone = fitTerminalToPhone && active,
                        promptHistory = model.promptHistory,
                        pageLabel = pageLabel,
                        nextNeedingYou = nextTaskNeedingYou(agents, agentId),
                        onOpenTask = { screenKey = "agent:$it" },
                        onZoomedChange = { zoomed ->
                            zoomedAgentId = if (zoomed) agentId else zoomedAgentId.takeUnless { it == agentId }
                        },
                        onBack = { screenKey = "agents" },
                        onPair = { screenKey = "pair" },
                    )
                }

                if (openIndex < 0 || pages.size < 2) {
                    // A task that left the list (or the only one) has nothing to swipe to.
                    Task(currentScreen.agentId, active = true, pageLabel = null)
                } else {
                    val pager = rememberPagerState(initialPage = openIndex) { pages.size }
                    val currentPages by rememberUpdatedState(pages)
                    // Opening another task without swiping (Next task, a notification) turns the
                    // pager to it. A swipe has already settled there, so it does nothing then. Keyed
                    // by task rather than index: pages are keyed by task, so a reorder keeps the open
                    // one in view by itself, and must not scroll mid-swipe.
                    LaunchedEffect(pager, currentScreen.agentId) {
                        val target = currentPages.indexOfFirst { it.agentId == currentScreen.agentId }
                        if (target >= 0 && currentPages.getOrNull(pager.currentPage)?.agentId != currentScreen.agentId) {
                            pager.scrollToPage(target)
                        }
                    }
                    LaunchedEffect(pager) {
                        snapshotFlow { pager.settledPage }.collect { page ->
                            // Only a swipe moves between tasks. This page stays composed while it
                            // animates out, so once the screen is left (Back, or closing the task,
                            // which also changes the list) it must not navigate to a neighbour.
                            if (!screenKey.startsWith("agent:")) return@collect
                            currentPages.getOrNull(page)?.let { screenKey = "agent:${it.agentId}" }
                        }
                    }
                    HorizontalPager(
                        state = pager,
                        userScrollEnabled = zoomedAgentId != currentScreen.agentId,
                        key = { pages[it].agentId },
                        pageSpacing = 8.dp,
                    ) { page ->
                        // Only the settled page may resize the desktop terminal; a neighbour
                        // composed mid-swipe just shows its output.
                        Task(pages[page].agentId, active = page == pager.settledPage, pageLabel = "${page + 1} of ${pages.size}")
                    }
                }
            }
        }
    }
}
