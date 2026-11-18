package com.parallelcode.phone

import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

/**
 * Feeds the streams in terminal-golden.json, rendered by the desktop's own terminal engine
 * (electron/remote/terminal-golden.test.ts), and expects this app's emulator to show the same
 * lines. Each stream comes twice: as raw output and as the snapshot the server sends on open.
 */
class TerminalGoldenTest {
    private val cases: JSONArray =
        JSONArray(requireNotNull(javaClass.classLoader?.getResource("terminal-golden.json")).readText())

    private fun JSONObject.lines(): List<String> {
        val lines = getJSONArray("lines")
        return List(lines.length()) { lines.getString(it) }
    }

    @Test
    fun showsWhatTheDesktopShows() {
        val failures = (0 until cases.length()).map(cases::getJSONObject).mapNotNull { case ->
            val screen = TerminalScreen()
            screen.reset(case.getInt("cols"), case.getInt("rows"), Base64.getDecoder().decode(case.getString("data")))
            val lines = screen.text().split('\n').map(String::trimEnd).let { if (it == listOf("")) emptyList() else it }
            val copy = screen.copyText(maxLines = 10_000, maxChars = 1_000_000)
            val name = case.getString("name")
            when {
                lines != case.lines() -> "$name: lines ${case.lines()} expected, got $lines"
                copy != case.getString("copy") -> "$name: copy ${case.getString("copy")} expected, got $copy"
                else -> null
            }
        }
        assertEquals("", failures.joinToString("\n"))
    }
}
