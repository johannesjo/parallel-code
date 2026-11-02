package com.parallelcode.phone

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProjectMarkTest {
    @Test
    fun parsesTheProjectColorsTheDesktopStores() {
        assertEquals(Color(0xFFFF8800), parseCssColor("#ff8800"))
        assertEquals(Color(0xFFFF8800), parseCssColor("#F80"))
        assertEquals(Color.hsl(220f, 0.7f, 0.62f), parseCssColor("hsl(220, 70%, 62%)"))
        assertEquals(Color.hsl(220f, 0.7f, 0.62f), parseCssColor(" hsl(220deg 70% 62%) "))
    }

    @Test
    fun rejectsColorsItCannotDraw() {
        assertNull(parseCssColor(null))
        assertNull(parseCssColor(""))
        assertNull(parseCssColor("#12345"))
        assertNull(parseCssColor("rebeccapurple"))
        assertNull(parseCssColor("var(--accent)"))
        assertNull(parseCssColor("hsl(1.2.3, 70%, 62%)"))
    }

    @Test
    fun knowsEveryDesktopIconIdItShips() {
        // The generator reads the desktop's file; an empty map would mean its regex stopped matching.
        assertEquals(true, PROJECT_ICON_PATHS.size > 50)
        assertEquals(true, PROJECT_ICON_PATHS.values.all { paths -> paths.all { it.startsWith("M", ignoreCase = true) } })
    }
}
