package com.parallelcode.phone

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentWheelTest {
    private fun wheel(turns: MutableList<Int>) = AgentWheel().apply {
        linePx = 10f
        onWheel = { turns += it }
    }

    @Test
    fun turnsTheWheelUpForADragDownTheTerminalCannotFollow() {
        val turns = mutableListOf<Int>()
        val wheel = wheel(turns)
        val left = wheel.onPostScroll(Offset.Zero, Offset(0f, 25f), NestedScrollSource.UserInput)
        assertEquals(listOf(-2), turns)
        assertEquals(Offset(0f, 25f), left)
        // The half line left over carries into the next drag step.
        wheel.onPostScroll(Offset.Zero, Offset(0f, 5f), NestedScrollSource.UserInput)
        wheel.onPostScroll(Offset.Zero, Offset(0f, -40f), NestedScrollSource.UserInput)
        assertEquals(listOf(-2, -1, 4), turns)
    }

    @Test
    fun leavesFlingsAndOrdinaryTerminalsAlone() {
        val turns = mutableListOf<Int>()
        val wheel = wheel(turns)
        assertEquals(Offset.Zero, wheel.onPostScroll(Offset.Zero, Offset(0f, 50f), NestedScrollSource.SideEffect))
        wheel.onWheel = null
        assertEquals(Offset.Zero, wheel.onPostScroll(Offset.Zero, Offset(0f, 50f), NestedScrollSource.UserInput))
        assertEquals(emptyList<Int>(), turns)
    }
}
