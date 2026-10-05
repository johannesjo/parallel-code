package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalScreenTest {
    private fun screen(cols: Int = 10, rows: Int = 3, data: String = "") =
        TerminalScreen().apply { reset(cols, rows, data.toByteArray()) }

    @Test
    fun appliesCursorMovementAndErase() {
        val s = screen(data = "hello\r\nworld\u001b[1;1Hj\u001b[2;3H\u001b[K")
        assertEquals("jello\nwo", s.text())
    }

    @Test
    fun dropsColorsAndTitles() {
        val s = screen(data = "\u001b]0;title\u0007\u001b[1;31mred\u001b[0m ok")
        assertEquals("red ok", s.text())
    }

    @Test
    fun scrollsFullLinesIntoHistory() {
        val s = screen(rows = 2, data = "1\r\n2\r\n3\r\n4")
        assertEquals("1\n2\n3\n4", s.text())
    }

    @Test
    fun wrapsOnlyWhenTheNextCharacterArrives() {
        val s = screen(cols = 3, data = "abc\r\nd")
        assertEquals("abc\nd", s.text())
        assertEquals("abc\nd", screen(cols = 3, data = "abcd").text())
    }

    @Test
    fun preservesHistoryWhenScrollRegionStartsAtTop() {
        // Status line pinned at the bottom; lines scrolling off the top go to history.
        val s = screen(rows = 3, data = "\u001b[3;1Hstatus\u001b[1;2r\u001b[1;1Ha\r\nb\r\nc")
        assertEquals("a\nb\nc\nstatus", s.text())
    }

    @Test
    fun keepsSubRegionRedrawsOutOfHistoryWhenHeaderPinned() {
        // Header pinned at row 1; only rows 2-3 scroll.
        val s = screen(rows = 3, data = "\u001b[1;1Hheader\u001b[2;3r\u001b[2;1Ha\r\nb\r\nc")
        assertEquals("header\nb\nc", s.text())
    }

    @Test
    fun preservesHistoryAcrossMultipleScrollsWithPinnedFooter() {
        // TUI with 4 rows: row 4 is a pinned status footer, rows 1-3 scroll.
        // Print 10 lines through the scrolling region.
        val input = StringBuilder("\u001b[4;1Hfooter\u001b[1;3r\u001b[1;1H")
        for (i in 1..10) {
            input.append("line $i\r\n")
        }
        val s = screen(rows = 4, data = input.toString())
        val text = s.text()
        assertTrue(text.contains("line 1"))
        assertTrue(text.contains("line 10"))
        assertTrue(text.contains("footer"))
        // 7 lines scrolled into history + 4 lines on grid (including trailing lines)
        val lines = s.styledLines()
        assertTrue(lines.size >= 10)
    }

    @Test
    fun restoresTheMainScreenAfterAFullScreenProgram() {
        val s = screen(data = "shell\u001b[?1049hvim stuff\u001b[?1049l")
        assertEquals("shell", s.text())
    }

    @Test
    fun decodesUtf8SplitAcrossChunks() {
        val s = screen()
        val bytes = "é✓".toByteArray()
        s.feed(bytes.copyOfRange(0, 1))
        s.feed(bytes.copyOfRange(1, bytes.size))
        assertEquals("é✓", s.text())
    }

    @Test
    fun tracksBracketedPasteMode() {
        val s = screen(data = "\u001b[?2004h")
        assertTrue(s.bracketedPaste)
        s.feed("\u001b[?2004l".toByteArray())
        assertEquals(false, s.bracketedPaste)
    }

    @Test
    fun keepsColorsPerCell() {
        val s = screen(cols = 20, data = "\u001b[31mred\u001b[0m \u001b[1;38;2;1;2;3mrgb\u001b[m")
        val (red, plain, rgb) = s.styledLines().single()
        assertEquals("red", red.text)
        assertEquals(1, CellStyle.fg(red.style))
        assertEquals(CellStyle.DEFAULT, plain.style)
        assertEquals(CellStyle.RGB_FLAG or 0x010203, CellStyle.fg(rgb.style))
        assertTrue(CellStyle.flags(rgb.style) and CellStyle.BOLD != 0)
    }

    @Test
    fun erasePaintsTheCurrentBackground() {
        val s = screen(cols = 4, rows = 1, data = "\u001b[44m\u001b[2K\u001b[0mx")
        val spans = s.styledLines().single()
        assertEquals(listOf("x", "   "), spans.map { it.text })
        assertEquals(4, CellStyle.bg(spans[1].style))
    }

    @Test
    fun retainsUpTo5000LinesOfHistory() {
        val s = screen(rows = 2)
        // Feed 5,050 lines
        for (i in 1..5050) {
            s.feed("L$i\r\n".toByteArray())
        }
        val lines = s.styledLines()
        // Should keep 5000 history lines + 1 non-empty grid row (trailing blank row is trimmed)
        assertEquals(5001, lines.size)
        // Earliest line should be L50, since 1-49 were pruned past 5000
        val text = s.text()
        assertTrue(text.contains("L5050"))
        assertTrue(text.contains("L52"))
        assertEquals(false, text.contains("L40\n"))
    }

    @Test
    fun resizeKeepsTheCursorLineAndScrollsTheTopIntoHistory() {
        val s = screen(cols = 5, rows = 3, data = "a\r\nb\r\nc")
        s.resize(4, 2)
        assertEquals("a\nb\nc", s.text())
        s.feed("\u001b[1;1Hx".toByteArray())
        assertEquals("a\nx\nc", s.text())
    }

    @Test
    fun resizeGrowsAndTruncatesColumns() {
        val s = screen(cols = 5, rows = 2, data = "abcde")
        s.resize(3, 4)
        assertEquals("abc", s.text())
        s.feed("\u001b[4;1Hz".toByteArray())
        assertEquals("abc\n\n\nz", s.text())
    }
}
