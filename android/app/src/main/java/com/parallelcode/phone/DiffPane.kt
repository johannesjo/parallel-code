package com.parallelcode.phone

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Diff lines shown per file on the phone; the desktop shows the rest. */
private const val MAX_FILE_LINES = 1500

/** The task's changes against its base branch, file by file, as the desktop's diff view. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiffPane(taskId: String, client: RemoteClient, modifier: Modifier) {
    var reload by remember { mutableIntStateOf(0) }
    var files by remember(taskId) { mutableStateOf<List<DiffFile>?>(null) }
    var truncated by remember(taskId) { mutableStateOf(false) }
    var unsupported by remember(taskId) { mutableStateOf(false) }
    var error by remember(taskId) { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    LaunchedEffect(taskId, reload) {
        loading = true
        error = null
        try {
            val result = client.fetchDiff(taskId)
            files = parseUnifiedDiff(result.diff)
            truncated = result.truncated
            unsupported = result.unsupported
        } catch (e: ApiException) {
            error = if (e.status == 403 || e.status == 404) "Update Parallel Code on your computer to see changes here." else e.message
        } finally {
            loading = false
        }
    }

    Column(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val current = files
            Text(
                when {
                    current == null -> ""
                    unsupported -> ""
                    current.isEmpty() -> "No changes"
                    else -> "${current.size} file${if (current.size == 1) "" else "s"} · +${current.sumOf { it.added }} −${current.sumOf { it.removed }}"
                },
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = AppTheme.extra.textMuted,
            )
            TextButton(onClick = { reload++ }, enabled = !loading) { Text("Refresh") }
        }
        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.border)
        error?.let {
            Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error)
            return@Column
        }
        val current = files ?: run {
            if (loading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp) }
            }
            return@Column
        }
        if (unsupported) {
            Text(
                "This task works directly in the project folder, so there is no branch to compare.",
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                color = AppTheme.extra.textMuted,
                style = MaterialTheme.typography.bodySmall,
            )
            return@Column
        }
        if (truncated) {
            Text(
                "This diff is too large for the phone; showing the start.",
                Modifier
                    .fillMaxWidth()
                    .background(AppTheme.extra.warningBannerBg)
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                color = AppTheme.extra.warningText,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        // Pull down to refresh, as on the agent list.
        PullToRefreshBox(isRefreshing = loading, onRefresh = { reload++ }, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize()) {
                items(current, key = { it.path }) { file -> DiffFileRow(file) }
            }
        }
    }
}

@Composable
private fun DiffFileRow(file: DiffFile) {
    var open by rememberSaveable(file.path) { mutableStateOf(false) }
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = !file.binary) { open = !open }
                .padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (open) "▾" else "▸", color = AppTheme.extra.textMuted)
            Text(
                file.path,
                Modifier.weight(1f),
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                maxLines = 2,
                overflow = TextOverflow.StartEllipsis,
            )
            if (file.binary) {
                Text("binary", style = MaterialTheme.typography.bodySmall, color = AppTheme.extra.textMuted)
            } else {
                Text("+${file.added}", color = AppTheme.extra.success, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text("−${file.removed}", color = MaterialTheme.colorScheme.error, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        AnimatedVisibility(visible = open, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            DiffLines(file)
        }
        HorizontalDivider(thickness = 1.dp, color = AppTheme.extra.borderSubtle)
    }
}

@Composable
private fun DiffLines(file: DiffFile) {
    val added = AppTheme.extra.success
    val removed = MaterialTheme.colorScheme.error
    val hunk = AppTheme.extra.textMuted
    Box(
        Modifier
            .fillMaxWidth()
            .background(AppTheme.extra.inputBg)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Column {
            file.lines.take(MAX_FILE_LINES).forEach { line ->
                val (fg, bg) = when {
                    line.startsWith("@@") -> hunk to Color.Transparent
                    line.startsWith("+") -> added to added.copy(alpha = 0.12f)
                    line.startsWith("-") -> removed to removed.copy(alpha = 0.12f)
                    else -> MaterialTheme.colorScheme.onSurface to Color.Transparent
                }
                Text(
                    line.ifEmpty { " " },
                    Modifier.background(bg),
                    color = fg,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    lineHeight = 14.sp,
                    softWrap = false,
                )
            }
            if (file.lines.size > MAX_FILE_LINES) {
                Text("… ${file.lines.size - MAX_FILE_LINES} more lines on your computer", color = hunk, fontSize = 11.sp)
            }
        }
    }
}
