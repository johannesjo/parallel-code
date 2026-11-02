package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalFontTest {
    @Test
    fun shrinksAWideDesktopTerminalUntilEveryColumnFits() {
        // 250 columns of 0.6em cells in 1000px: any larger font would wrap the rows.
        val font = fittedTerminalFont(textWidthPx = 1000, cols = 250, charPxAt10 = 6f)
        assertTrue("$font sp overflows", font * 0.6f * 250 <= 1000f)
        assertEquals(1000f / (0.6f * 250), font, 0.01f)
    }

    @Test
    fun capsTheFontForANarrowTerminal() {
        assertEquals(14f, fittedTerminalFont(textWidthPx = 1000, cols = 40, charPxAt10 = 6f), 0f)
    }
}
