package com.parallelcode.phone

import android.app.Application
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Owns the connection so the visible app and the background notification service share one socket
 * (see [RemoteClient.start]).
 */
class PhoneApplication : Application() {
    lateinit var networkMonitor: NetworkMonitor
        private set
    lateinit var client: RemoteClient
        private set
    lateinit var settings: SettingsStore
        private set
    lateinit var promptHistory: PromptHistoryStore
        private set
    lateinit var updates: AppUpdates
        private set

    /** True while the app is on screen; agent notifications stay quiet then. */
    @Volatile
    var inForeground = false

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(getSharedPreferences(SettingsStore.PREFS_NAME, Context.MODE_PRIVATE))
        networkMonitor = NetworkMonitor(this)
        networkMonitor.start()
        client = RemoteClient(
            CredentialStore(getSharedPreferences(CredentialStore.PREFS_NAME, Context.MODE_PRIVATE)),
            vpnActive = networkMonitor.isVpnActive,
            wifiSsid = networkMonitor.wifiSsid,
            waitForVpn = { settings.waitForVpn },
            homeWifiSsid = { settings.homeWifiSsid },
        )
        promptHistory = PromptHistoryStore(getSharedPreferences(PromptHistoryStore.PREFS_NAME, Context.MODE_PRIVATE))
        updates = AppUpdates(this)
        // Keep the home-screen widget current whenever the connection is open.
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).launch {
            combine(client.agents, client.usage, client.state, client.otherComputers, client.computers) {
                    agents, usage, state, others, computers ->
                val label = computers.firstOrNull { it.baseUrl == state.link?.baseUrl }?.label.orEmpty()
                widgetSummary(
                    ComputerSnapshot(label, agents, usage),
                    state.status == ConnectionStatus.CONNECTED,
                    others.values.toList(),
                )
            }.collect { AgentWidget.publish(this@PhoneApplication, it) }
        }
    }
}
