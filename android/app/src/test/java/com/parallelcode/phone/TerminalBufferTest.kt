package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalBufferTest {
    @Test
    fun updatesVersionAndResetsScreenOnScrollback() {
        val buffer = TerminalBuffer("agent-1")
        assertEquals(0, buffer.version.value)

        buffer.onScrollback("initial output\r\n".toByteArray(), cols = 40, rows = 10)
        assertEquals(1, buffer.version.value)
        assertTrue(buffer.screen.text().contains("initial output"))
    }

    @Test
    fun updatesVersionAndAppendsOutput() {
        val buffer = TerminalBuffer("agent-1")
        buffer.onScrollback("step 1\r\n".toByteArray(), cols = 40, rows = 10)
        assertEquals(1, buffer.version.value)

        buffer.onOutput("step 2\r\n".toByteArray())
        assertEquals(2, buffer.version.value)
        val text = buffer.screen.text()
        assertTrue(text.contains("step 1"))
        assertTrue(text.contains("step 2"))
    }

    @Test
    fun retainsDeepScrollbackHistory() {
        val buffer = TerminalBuffer("agent-1")
        // Feed 100 lines through a 5-row screen
        buffer.onScrollback("".toByteArray(), cols = 40, rows = 5)
        for (i in 1..100) {
            buffer.onOutput("log line $i\r\n".toByteArray())
        }
        val text = buffer.screen.text()
        assertTrue(text.contains("log line 1"))
        assertTrue(text.contains("log line 100"))
        assertTrue(buffer.screen.styledLines().size >= 100)
    }
}
