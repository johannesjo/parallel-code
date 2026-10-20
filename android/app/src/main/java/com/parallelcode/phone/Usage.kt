package com.parallelcode.phone

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.text.NumberFormat
import java.time.format.DateTimeFormatter
import java.util.Currency
import java.util.Locale
import kotlin.math.roundToInt

// Mirrors UsageState in electron/ipc/shared-types.ts and the helpers in src/components/usage-format.ts.

data class UsageWindow(val usedPercent: Double, val resetsAt: Long?) {
    val remainingPercent: Int
        get() = maxOf(0, (100 - usedPercent).roundToInt())
    val warn: Boolean
        get() = usedPercent >= USAGE_WARN_PERCENT
}

/** Pay-as-you-go spend for the billing period, in standard units of [currency] (2.12 for $2.12). */
data class CreditUsage(val used: Double, val limit: Double?, val currency: String, val usedPercent: Double?) {
    val warn: Boolean
        get() = (usedPercent ?: 0.0) >= USAGE_WARN_PERCENT
}

data class ProviderUsage(
    val label: String,
    val fiveHour: UsageWindow?,
    val sevenDay: UsageWindow?,
    /** `error` keeps the last snapshot but marks it stale. */
    val status: String,
    val error: String?,
    val creditUsage: CreditUsage? = null,
) {
    val hasSnapshot: Boolean
        get() = fiveHour != null || sevenDay != null || creditUsage != null
}

/** Past this share of a window, the meter turns amber. */
private const val USAGE_WARN_PERCENT = 80

private val PROVIDERS = listOf(
    "claude" to "Claude",
    "codex" to "Codex",
    "antigravity" to "Antigravity",
)

/**
 * Providers the desktop status bar would show: those with a snapshot, plus those whose refresh
 * failed so the reader sees why the meter stopped moving.
 */
fun parseUsage(json: JSONObject): List<ProviderUsage> {
    val result = mutableListOf<ProviderUsage>()
    val seen = mutableSetOf<String>()

    for ((key, label) in PROVIDERS) {
        val p = json.optJSONObject(key) ?: continue
        seen.add(key)
        val usage = parseProvider(label, p)
        if (usage.hasSnapshot || usage.status == "error") {
            result.add(usage)
        }
    }

    for (key in json.keys()) {
        if (key in seen) continue
        val p = json.optJSONObject(key) ?: continue
        val label = when (key.lowercase(Locale.ROOT)) {
            "antigravity", "agy" -> "Antigravity"
            else -> key.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.getDefault()) else it.toString() }
        }
        val usage = parseProvider(label, p)
        if (usage.hasSnapshot || usage.status == "error") {
            result.add(usage)
        }
    }

    return result
}

private fun parseProvider(label: String, p: JSONObject) = ProviderUsage(
    label = label,
    fiveHour = p.optJSONObject("fiveHour")?.let(::parseWindow),
    sevenDay = p.optJSONObject("sevenDay")?.let(::parseWindow),
    status = p.optString("status"),
    error = if (p.isNull("error")) null else p.optString("error"),
    creditUsage = p.optJSONObject("creditUsage")?.let(::parseCreditUsage),
)

private fun parseCreditUsage(c: JSONObject) = CreditUsage(
    used = c.optDouble("used", 0.0),
    limit = if (c.isNull("limit")) null else c.optDouble("limit").takeIf { it > 0 },
    currency = c.optString("currency").ifEmpty { "USD" },
    usedPercent = if (c.isNull("usedPercent")) null else c.optDouble("usedPercent").takeIf { !it.isNaN() },
)

// Matches formatCurrency in src/components/usage-format.ts: always two decimals.
private fun formatMoney(amount: Double, code: String, locale: Locale): String {
    val currency = runCatching { Currency.getInstance(code) }.getOrNull()
        ?: return String.format(locale, "$%.2f", amount)
    return NumberFormat.getCurrencyInstance(locale).apply {
        this.currency = currency
        minimumFractionDigits = 2
        maximumFractionDigits = 2
    }.format(amount)
}

/** "$12.34 / $50.00" against a cap, "$12.34 used" without one, as the desktop bar shows it. */
fun formatCredit(credit: CreditUsage, locale: Locale = Locale.getDefault()): String {
    val used = formatMoney(credit.used, credit.currency, locale)
    val limit = credit.limit ?: return "$used used"
    return "$used / ${formatMoney(limit, credit.currency, locale)}"
}

private fun parseWindow(w: JSONObject) = UsageWindow(
    usedPercent = w.optDouble("usedPercent", 0.0),
    resetsAt = if (w.isNull("resetsAt")) null else w.optLong("resetsAt").takeIf { it > 0 },
)

/** "resets 14:30" today, "resets Thu 09:00" otherwise, "reset due" once passed, "" when unknown. */
fun formatReset(
    resetsAt: Long?,
    now: Long = System.currentTimeMillis(),
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): String {
    if (resetsAt == null) return ""
    if (resetsAt <= now) return "reset due"
    val at = Instant.ofEpochMilli(resetsAt).atZone(zone)
    val time = at.format(DateTimeFormatter.ofPattern("HH:mm", locale))
    if (at.toLocalDate() == Instant.ofEpochMilli(now).atZone(zone).toLocalDate()) return "resets $time"
    return "resets ${at.format(DateTimeFormatter.ofPattern("EEE", locale))} $time"
}

// The desktop polls the usage endpoints itself; this only re-reads its snapshot.
private const val USAGE_POLL_MS = 60_000L

/** The desktop status bar's subscription meters. Hidden until the desktop has a snapshot. */
@Composable
fun UsageStrip(client: RemoteClient, connected: Boolean) {
    var usage by remember { mutableStateOf<List<ProviderUsage>>(emptyList()) }
    var refresh by remember { mutableIntStateOf(0) }
    // Reads on every (re)connect and tap, then once a minute.
    LaunchedEffect(connected, refresh) {
        while (connected) {
            try {
                usage = client.fetchUsage()
            } catch (_: ApiException) {
                // Keep the last snapshot; the connection status already reports outages.
            }
            delay(USAGE_POLL_MS)
        }
    }
    if (usage.isEmpty()) return
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .semantics { contentDescription = "Agent usage, tap to refresh" }
            .clickable { refresh++ },
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, AppTheme.extra.border),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            usage.forEach { provider ->
                val stale = provider.status == "error"
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        provider.label.uppercase(),
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.labelSmall,
                        color = AppTheme.extra.textMuted,
                    )
                    provider.fiveHour?.let { UsageMeter("5h", it, stale) }
                    provider.sevenDay?.let { UsageMeter("7d", it, stale) }
                    provider.creditUsage?.let { CreditRow(it, stale) }
                    if (!provider.hasSnapshot) {
                        Text(
                            "usage unavailable · ${provider.error.orEmpty()}",
                            style = MaterialTheme.typography.bodySmall,
                            color = AppTheme.extra.textSubtle,
                        )
                    }
                }
            }
        }
    }
}

/** Pay-as-you-go spend against the period cap, for logins billed per use. */
@Composable
private fun CreditRow(credit: CreditUsage, stale: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            "credits",
            Modifier.padding(end = 8.dp),
            style = MaterialTheme.typography.bodySmall,
            color = AppTheme.extra.textMuted,
        )
        Text(
            formatCredit(credit),
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
            color = when {
                stale -> AppTheme.extra.textSubtle
                credit.warn -> AppTheme.extra.warningText
                else -> MaterialTheme.colorScheme.onSurface
            },
        )
    }
}

@Composable
private fun UsageMeter(label: String, window: UsageWindow, stale: Boolean) {
    val left = window.remainingPercent
    val isCritical = left <= 5 || window.usedPercent >= 95.0
    val fill = when {
        stale -> AppTheme.extra.textSubtle
        isCritical -> MaterialTheme.colorScheme.error
        window.warn -> AppTheme.extra.warningText
        else -> MaterialTheme.colorScheme.primary
    }
    // Fills from empty on first show, then eases between snapshots.
    val target = (left / 100f).coerceIn(0f, 1f)
    val progress = remember { Animatable(0f) }
    LaunchedEffect(target) { progress.animateTo(target, tween(durationMillis = 700, easing = FastOutSlowInEasing)) }
    val animatedProgress = progress.value
    val textColor = when {
        stale -> AppTheme.extra.textSubtle
        isCritical -> MaterialTheme.colorScheme.error
        window.warn -> AppTheme.extra.warningText
        else -> MaterialTheme.colorScheme.onSurface
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            Modifier.width(28.dp),
            style = MaterialTheme.typography.bodySmall,
            color = AppTheme.extra.textMuted,
        )
        Box(
            Modifier
                .weight(1f)
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(MaterialTheme.colorScheme.background)
                .border(BorderStroke(1.dp, AppTheme.extra.border), RoundedCornerShape(3.dp))
                .semantics { contentDescription = "$label window $left% remaining" },
        ) {
            Box(
                Modifier
                    .fillMaxHeight()
                    .fillMaxWidth(animatedProgress)
                    .background(fill),
            )
        }
        Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "$left% left",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = textColor,
            )
            val reset = if (window.remainingPercent == 100) "" else formatReset(window.resetsAt)
            if (reset.isNotEmpty()) {
                Text(
                    " · $reset",
                    style = MaterialTheme.typography.bodySmall,
                    color = AppTheme.extra.textMuted,
                )
            }
        }
    }
}
