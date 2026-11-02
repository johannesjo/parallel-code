package com.parallelcode.phone

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** System integrations such as dictation use an explicit local simulation inside the demo. */
internal val LocalDemoMode = staticCompositionLocalOf { false }

@Composable
internal fun DemoFrame(active: Boolean, onReset: () -> Unit, onExit: () -> Unit, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalDemoMode provides active) {
        if (!active) {
            content()
            return@CompositionLocalProvider
        }
        Surface(color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxSize().statusBarsPadding().consumeWindowInsets(WindowInsets.statusBars)) {
                Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Demo · offline samples", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    TextButton(onClick = onReset) { Text("Reset") }
                    TextButton(onClick = onExit) { Text("Exit demo") }
                }
                Text("Actions stay on this phone. Device integrations are simulated.", Modifier.padding(horizontal = 12.dp).padding(bottom = 6.dp),
                    style = MaterialTheme.typography.labelSmall, color = AppTheme.extra.textMuted)
                HorizontalDivider(color = AppTheme.extra.border)
                Column(Modifier.weight(1f)) { content() }
            }
        }
    }
}

@Composable
internal fun DemoConnectScreen(session: DemoSession, saved: List<SavedComputer>, onDone: () -> Unit, onCancel: (() -> Unit)? = null) {
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Connect a sample computer", style = MaterialTheme.typography.titleLarge)
        Text("This replaces scanning or pasting a real desktop link with an offline sample. Add a sample computer, then enter 123456 to try pairing.")
        saved.forEach { computer ->
            OutlinedButton(onClick = { session.switchTo(computer.baseUrl); onDone() }, modifier = Modifier.fillMaxWidth()) {
                Text(computer.label)
            }
        }
        OutlinedButton(onClick = { session.addComputer(); onDone() }, modifier = Modifier.fillMaxWidth()) {
            Text("Add sample computer")
        }
        onCancel?.let { TextButton(onClick = it) { Text("Cancel") } }
    }
}
