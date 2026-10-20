package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class ChatScrollTest {
    private val keys = listOf<Any>("item:a", "item:b", "item:c", "request:1")

    @Test
    fun opensWhereTheReaderLeft() {
        assertEquals(1 to 42, chatOpeningScroll(keys, ChatScroll("item:b", 42)))
    }

    @Test
    fun opensAtTheNewestMessageWithoutASavedPosition() {
        assertEquals(3 to 0, chatOpeningScroll(keys, null))
    }

    @Test
    fun opensAtTheNewestMessageWhenTheSavedItemIsGone() {
        assertEquals(3 to 0, chatOpeningScroll(keys, ChatScroll("item:cleared", 42)))
    }

    @Test
    fun opensAnEmptyChatAtTheTop() {
        assertEquals(0 to 0, chatOpeningScroll(emptyList(), null))
    }

    @Test
    fun keepsNothingWhenLeftAtTheEnd() {
        assertEquals(true, leftAtNewest(firstIndex = 1, newestIndex = 3, canScrollForward = false))
    }

    @Test
    fun keepsNothingWhenLeftOnTheNewestMessageTallerThanTheScreen() {
        assertEquals(true, leftAtNewest(firstIndex = 3, newestIndex = 3, canScrollForward = true))
    }

    @Test
    fun keepsThePositionWhenScrolledUp() {
        assertEquals(false, leftAtNewest(firstIndex = 1, newestIndex = 3, canScrollForward = true))
    }
}
