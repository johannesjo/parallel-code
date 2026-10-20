package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PromptHistoryStoreTest {

    private lateinit var prefs: FakeSharedPreferences
    private lateinit var store: PromptHistoryStore

    @Before
    fun setUp() {
        prefs = FakeSharedPreferences()
        store = PromptHistoryStore(prefs)
    }

    @Test
    fun startsEmptyAndIgnoresBlanks() {
        assertTrue(store.history("a").isEmpty())
        store.record("a", "   ")
        assertTrue(store.history("a").isEmpty())
    }

    @Test
    fun newestFirstAndRepeatsMoveToFront() {
        store.record("a", "first")
        store.record("a", "second")
        store.record("a", "first")
        assertEquals(listOf("first", "second"), store.history("a"))
    }

    @Test
    fun historiesAreScopedPerAgent() {
        store.record("a", "hello")
        assertTrue(store.history("b").isEmpty())
        assertEquals(listOf("hello"), store.history("a"))
    }

    @Test
    fun capsMessagesPerAgent() {
        repeat(PromptHistoryStore.MAX_PER_AGENT + 5) { store.record("a", "msg $it") }
        val history = store.history("a")
        assertEquals(PromptHistoryStore.MAX_PER_AGENT, history.size)
        assertEquals("msg ${PromptHistoryStore.MAX_PER_AGENT + 4}", history.first())
    }

    @Test
    fun survivesAReread() {
        store.record("a", "hello")
        val reread = PromptHistoryStore(prefs)
        assertEquals(listOf("hello"), reread.history("a"))
    }
}
