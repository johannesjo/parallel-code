package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskGroupsTest {
    private fun agent(
        id: String,
        attention: String,
        running: Boolean = true,
        collapsed: Boolean = false,
        project: String? = null,
        agentName: String? = null,
    ) = RemoteAgent(
        agentId = id, taskId = id, taskName = "Task $id", running = running, exitCode = null, lastLine = "",
        projectName = project, agentName = agentName, attention = attention, isChat = false, collapsed = collapsed,
    )

    @Test
    fun groupsByWhatTheTaskNeeds() {
        assertEquals(TaskGroup.NEEDS_YOU, taskGroup(agent("a", "needs_input")))
        assertEquals(TaskGroup.NEEDS_YOU, taskGroup(agent("a", "error")))
        assertEquals(TaskGroup.WORKING, taskGroup(agent("a", "active")))
        assertEquals(TaskGroup.REVIEW, taskGroup(agent("a", "review")))
        assertEquals(TaskGroup.REVIEW, taskGroup(agent("a", "ready")))
        assertEquals(TaskGroup.OTHER, taskGroup(agent("a", "idle")))
        assertEquals(TaskGroup.OTHER, taskGroup(agent("a", "shell_busy")))
        assertEquals(TaskGroup.OTHER, taskGroup(agent("a", "needs_input", running = false)))
    }

    @Test
    fun groupsKeepDisplayOrderAndSkipEmptyOnes() {
        val agents = listOf(agent("a", "active"), agent("b", "idle"), agent("c", "needs_input"), agent("d", "active"))
        val groups = groupTasks(agents)
        assertEquals(listOf(TaskGroup.NEEDS_YOU, TaskGroup.WORKING, TaskGroup.OTHER), groups.map { it.first })
        assertEquals(listOf("a", "d"), groups[1].second.map { it.agentId })
    }

    @Test
    fun listOrderPutsMinimizedTasksLast() {
        val agents = listOf(
            agent("a", "active"),
            agent("b", "error", collapsed = true),
            agent("c", "review"),
            agent("d", "needs_input"),
        )
        assertEquals(listOf("d", "a", "c", "b"), taskListOrder(agents).map { it.agentId })
    }

    @Test
    fun filtersMatchTheirGroups() {
        assertTrue(TaskFilter.ALL.matches(agent("a", "idle")))
        assertTrue(TaskFilter.NEEDS_YOU.matches(agent("a", "error")))
        assertFalse(TaskFilter.NEEDS_YOU.matches(agent("a", "active")))
        assertTrue(TaskFilter.REVIEW.matches(agent("a", "ready")))
        assertFalse(TaskFilter.REVIEW.matches(agent("a", "needs_input")))
        assertEquals(TaskFilter.REVIEW, TaskFilter.fromKey("review"))
        assertEquals(TaskFilter.ALL, TaskFilter.fromKey("unknown"))
        assertEquals(TaskFilter.ALL, TaskFilter.fromKey(null))
    }

    @Test
    fun searchLooksAtTaskProjectAndAgent() {
        val a = agent("x", "idle", project = "Parallel Code", agentName = "Claude Code")
        assertTrue(matchesSearch(a, ""))
        assertTrue(matchesSearch(a, "  task X "))
        assertTrue(matchesSearch(a, "parallel"))
        assertTrue(matchesSearch(a, "CLAUDE"))
        assertFalse(matchesSearch(a, "codex"))
    }

    @Test
    fun nextTaskNeedingYouWrapsAndSkipsTheOpenOne() {
        val agents = listOf(
            agent("a", "needs_input"),
            agent("b", "active"),
            agent("c", "error"),
            agent("d", "needs_input", collapsed = true),
        )
        assertEquals("c", nextTaskNeedingYou(agents, "a")?.agentId)
        assertEquals("a", nextTaskNeedingYou(agents, "c")?.agentId)
        assertEquals("a", nextTaskNeedingYou(agents, "b")?.agentId)
        assertEquals("a", nextTaskNeedingYou(agents, "gone")?.agentId)
        assertNull(nextTaskNeedingYou(agents.take(2), "a"))
        assertNull(nextTaskNeedingYou(emptyList(), "a"))
    }
}
