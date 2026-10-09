package com.parallelcode.phone

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

/** Search field and filter chips above the task list, as in the phone web UI. */
@Composable
internal fun TaskSearchAndFilters(
    search: String,
    onSearch: (String) -> Unit,
    filter: TaskFilter,
    onFilter: (TaskFilter) -> Unit,
    countFor: (TaskFilter) -> Int,
) {
    val focusManager = LocalFocusManager.current
    Column(
        Modifier.padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        OutlinedTextField(
            value = search,
            onValueChange = onSearch,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            placeholder = { Text("Find a task, project, or agent", color = AppTheme.extra.textSubtle) },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = AppTheme.extra.textMuted) },
            trailingIcon = if (search.isNotEmpty()) {
                {
                    IconButton(onClick = { onSearch("") }) {
                        Icon(Icons.Filled.Close, contentDescription = "Clear search")
                    }
                }
            } else null,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            // The list filters as you type, so Search only puts the keyboard away.
            keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
            shape = MaterialTheme.shapes.large,
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = AppTheme.extra.inputBg,
                unfocusedContainerColor = AppTheme.extra.inputBg,
                focusedBorderColor = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = AppTheme.extra.border,
            ),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TaskFilter.entries.forEach { option ->
                FilterChip(
                    selected = filter == option,
                    onClick = { onFilter(option) },
                    label = { Text("${option.label} ${countFor(option)}") },
                    colors = FilterChipDefaults.filterChipColors(
                        labelColor = AppTheme.extra.textMuted,
                        selectedLabelColor = MaterialTheme.colorScheme.primary,
                        selectedContainerColor = AppTheme.extra.bgSelected,
                    ),
                )
            }
        }
    }
}

/** A section title such as "Needs you 2". */
@Composable
internal fun TaskGroupHeader(group: TaskGroup, count: Int, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 20.dp, top = 6.dp)
            .semantics { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            group.label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (group == TaskGroup.NEEDS_YOU) AppTheme.extra.warningText else AppTheme.extra.textMuted,
        )
        Text(
            count.toString(),
            style = MaterialTheme.typography.labelMedium,
            color = AppTheme.extra.textSubtle,
        )
    }
}

/** Shown when the search or filter hides every task, with a way back to all of them. */
@Composable
internal fun NoMatchingTasks(search: String, filter: TaskFilter, onShowAll: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            when {
                search.isNotBlank() -> "No matching tasks"
                filter == TaskFilter.NEEDS_YOU -> "Nothing needs you right now"
                else -> "Nothing to review yet"
            },
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = AppTheme.extra.textPrimary,
        )
        Text(
            if (search.isNotBlank()) {
                "Try a different name, or clear your filters for “${search.trim()}”."
            } else {
                "You can check the other tasks while your agents work."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = AppTheme.extra.textMuted,
        )
        OutlinedButton(onClick = onShowAll, shape = MaterialTheme.shapes.small) { Text("Show all tasks") }
    }
}
