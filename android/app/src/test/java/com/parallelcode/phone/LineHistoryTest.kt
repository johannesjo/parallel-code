package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class LineHistoryTest {
    @Test
    fun keepsTheNewestLinesUpToItsCapacity() {
        val history = LineHistory<Int>(capacity = 10, blockSize = 4)
        for (i in 1..23) {
            history.add(i)
            val expected = (maxOf(1, i - 9)..i).toList()
            assertEquals("after adding $i", expected, history.snapshot())
            assertEquals(expected.size, history.size)
        }
    }

    @Test
    fun aSnapshotDoesNotChangeWhenLinesAreAdded() {
        val history = LineHistory<Int>(capacity = 5, blockSize = 2)
        (1..5).forEach(history::add)
        val before = history.snapshot()
        (6..9).forEach(history::add)
        assertEquals(listOf(1, 2, 3, 4, 5), before)
        assertEquals(listOf(5, 6, 7, 8, 9), history.snapshot())
    }

    @Test
    fun clearEmptiesIt() {
        val history = LineHistory<Int>(capacity = 5, blockSize = 2)
        (1..7).forEach(history::add)
        history.clear()
        assertEquals(emptyList<Int>(), history.snapshot())
        history.add(8)
        assertEquals(listOf(8), history.snapshot())
    }

    @Test
    fun worksWithACapacityBelowOneBlock() {
        val history = LineHistory<Int>(capacity = 3, blockSize = 8)
        (1..20).forEach(history::add)
        assertEquals(listOf(18, 19, 20), history.snapshot())
    }
}
