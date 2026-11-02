package com.parallelcode.phone

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.text.HtmlCompat

/** Bundled policy remains available before pairing and without an internet connection. */
@Composable
fun PrivacyPolicyButton() {
    val context = LocalContext.current
    var visible by rememberSaveable { mutableStateOf(false) }
    TextButton(onClick = { visible = true }) { Text("Privacy policy") }
    if (visible) {
        val policy = remember {
            context.assets.open("privacy.html").bufferedReader().use { reader ->
                // Android's HTML parser prints the <title> text too, which would repeat the heading.
                val body = reader.readText().substringAfter("<body>").substringBefore("</body>")
                HtmlCompat.fromHtml(body, HtmlCompat.FROM_HTML_MODE_LEGACY).toString().trim()
            }
        }
        AlertDialog(
            onDismissRequest = { visible = false },
            title = { Text("Privacy policy") },
            text = { Text(policy, modifier = Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = { TextButton(onClick = { visible = false }) { Text("Close") } },
        )
    }
}
