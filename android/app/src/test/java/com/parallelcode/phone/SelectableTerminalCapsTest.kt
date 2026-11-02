package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class SelectableTerminalCapsTest {
    @Test
    fun keepsTheFullCapsAtTheDefaultFontSize() {
        assertEquals(2_000 to 100_000, selectableTerminalCaps(fontScale = 1f))
        assertEquals(2_000 to 100_000, selectableTerminalCaps(fontScale = 0.85f))
    }

    @Test
    fun shrinksTheCapsSoALargerFontKeepsTheSameHeight() {
        // Twice the font: each row is twice as tall and holds half the characters.
        assertEquals(1_000 to 25_000, selectableTerminalCaps(fontScale = 2f))
    }
}
