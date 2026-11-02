package com.parallelcode.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.MergeType
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

// GitHub's merged purple, as on the desktop board's PR chip.
private val MERGED = Color(0xFF8957E5)

/** The board card's meta line: the project's mark and name, then the agent. */
@Composable
internal fun TaskCardMeta(agent: RemoteAgent) {
    val names = listOfNotNull(agent.projectName?.takeIf { it.isNotBlank() }, agent.agentName?.takeIf { it.isNotBlank() })
    if (names.isEmpty()) return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (!agent.projectName.isNullOrBlank()) {
            ProjectMark(parseCssColor(agent.projectColor) ?: AppTheme.extra.textMuted, agent.projectIcon)
        }
        Text(
            names.joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = AppTheme.extra.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * The board card's PR row: a chip that opens the pull request, what its checks say, and whether
 * the desktop is babysitting it. Babysitting is switched on the computer; the phone only shows it.
 */
@Composable
internal fun TaskCardPr(pr: RemotePr) {
    val uriHandler = LocalUriHandler.current
    val prColor = when (pr.kind) {
        "ready" -> AppTheme.extra.success
        "merged" -> MERGED
        else -> AppTheme.extra.textMuted
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Chip(
            background = if (pr.kind == "failed") MaterialTheme.colorScheme.error.copy(alpha = 0.14f) else neutralChip(),
            onClick = { uriHandler.openUri(pr.url) },
        ) {
            when (pr.kind) {
                "ready" -> Icon(Icons.Filled.Check, contentDescription = null, tint = prColor, modifier = Modifier.size(12.dp))
                "merged" -> Icon(Icons.AutoMirrored.Filled.MergeType, contentDescription = null, tint = prColor, modifier = Modifier.size(12.dp))
            }
            Text(
                pr.number?.let { "PR #$it" } ?: "PR",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = if (pr.kind == "ready" || pr.kind == "merged") FontWeight.SemiBold else FontWeight.Normal,
                color = if (pr.kind == "failed") MaterialTheme.colorScheme.error else prColor,
            )
        }
        pr.label?.let { label ->
            Text(
                label,
                Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = if (pr.kind == "failed") FontWeight.SemiBold else FontWeight.Normal,
                color = if (pr.kind == "failed") MaterialTheme.colorScheme.error else AppTheme.extra.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (pr.babysit) {
            // A pressed toggle on the desktop, so it may carry the accent.
            val accent = MaterialTheme.colorScheme.primary
            Chip(background = accent.copy(alpha = 0.16f), border = accent.copy(alpha = 0.45f)) {
                Text("Babysitting", style = MaterialTheme.typography.labelSmall, color = accent)
            }
        }
    }
}

@Composable
private fun neutralChip(): Color = AppTheme.extra.textPrimary.copy(alpha = 0.07f)

@Composable
private fun Chip(
    background: Color,
    border: Color = Color.Transparent,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val shape = MaterialTheme.shapes.extraSmall
    Row(
        Modifier
            .height(22.dp)
            .clip(shape)
            .background(background)
            .border(1.dp, border, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) { content() }
}
