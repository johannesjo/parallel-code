package com.parallelcode.phone

import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * The task's actions behind one overflow button, so the title bar keeps room for the task name.
 * Pass null for an action the screen doesn't offer.
 */
@Composable
internal fun TaskActionsMenu(onFixCi: (() -> Unit)?, onMerge: (() -> Unit)?, onClose: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(Icons.Filled.MoreVert, contentDescription = "Task actions")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            val pick = { action: () -> Unit -> open = false; action() }
            // Red like the desktop's Fix CI button: a failed check is urgent.
            onFixCi?.let { TaskActionItem("Fix CI", danger = true) { pick(it) } }
            onMerge?.let { TaskActionItem("Merge", danger = false) { pick(it) } }
            TaskActionItem("Close task", danger = true) { pick(onClose) }
        }
    }
}

@Composable
private fun TaskActionItem(label: String, danger: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = {
            Text(label, color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        },
        onClick = onClick,
    )
}
