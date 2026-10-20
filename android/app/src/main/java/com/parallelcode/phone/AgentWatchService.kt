package com.parallelcode.phone

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Keeps the desktop connection open while the app is in the background and notifies when an agent
 * needs input, hits an error or finishes. Runs only while agent notifications are on in Settings.
 */
class AgentWatchService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val app get() = application as PhoneApplication

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels(this)
        ServiceCompat.startForeground(
            this,
            WATCHING_ID,
            watchingNotification(0),
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
        app.client.start(HOLDER)
        // The widget's usage lines; the app refreshes them itself while on screen.
        scope.launch {
            while (true) {
                if (!app.inForeground) runCatching { app.client.fetchUsage() }
                delay(USAGE_REFRESH_MS)
            }
        }
        val notifier = AgentNotifier()
        scope.launch {
            app.client.agents.collect { agents ->
                val notices = notifier.update(agents)
                if (!canNotify()) return@collect
                val manager = NotificationManagerCompat.from(this@AgentWatchService)
                try {
                    if (!app.inForeground) {
                        notices.filter { app.settings.notifiesFor(it.event) }.forEach { notice ->
                            manager.notify(notice.agent.agentId.hashCode(), agentNotification(notice))
                        }
                    }
                    manager.notify(WATCHING_ID, watchingNotification(agents.count { it.attention == "needs_input" }))
                } catch (_: SecurityException) {
                    // Revoked since canNotify(): skip this round rather than stop the service; the next update checks again.
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        scope.cancel()
        app.client.stop(HOLDER)
        super.onDestroy()
    }

    private fun canNotify() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED

    private fun openApp(agentId: String?): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        agentId?.let { intent.putExtra(MainActivity.EXTRA_AGENT_ID, it) }
        return PendingIntent.getActivity(
            this,
            agentId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun watchingNotification(needInput: Int) =
        NotificationCompat.Builder(this, CHANNEL_WATCHING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Watching your agents")
            .setContentText(
                when (needInput) {
                    0 -> "You'll be notified when one needs you."
                    1 -> "1 agent needs input."
                    else -> "$needInput agents need input."
                },
            )
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp(null))
            .build()

    private fun agentNotification(notice: AgentNotice) =
        NotificationCompat.Builder(this, CHANNEL_AGENTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.agent.taskName)
            .setContentText(
                when (notice.event) {
                    AgentEvent.NEEDS_INPUT -> "Needs your input"
                    AgentEvent.ERROR -> "Hit an error"
                    AgentEvent.FINISHED -> "Finished"
                },
            )
            .setSubText(notice.agent.agentName)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openApp(notice.agent.agentId))
            .build()

    companion object {
        private const val HOLDER = "notifications"
        private const val USAGE_REFRESH_MS = 5 * 60_000L
        private const val WATCHING_ID = 1
        private const val CHANNEL_AGENTS = "agents"
        private const val CHANNEL_WATCHING = "watching"

        /** Start or stop the service to match the setting and whether a computer is linked. */
        fun sync(context: Context) {
            val app = context.applicationContext as PhoneApplication
            val intent = Intent(context, AgentWatchService::class.java)
            if (app.settings.notificationsEnabled && app.client.state.value.link != null) {
                ContextCompat.startForegroundService(context, intent)
            } else {
                context.stopService(intent)
            }
        }

        private fun createChannels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_AGENTS, "Agent updates", NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = "An agent needs input, hit an error or finished." },
            )
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_WATCHING, "Watching agents", NotificationManager.IMPORTANCE_MIN)
                    .apply { description = "Shown while the app keeps the connection open in the background." },
            )
        }
    }
}
