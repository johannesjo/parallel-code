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
        ci: String? = null,
        lane: String? = null,
    ) = RemoteAgent(
        agentId = id, taskId = id, taskName = "Task $id", running = running, exitCode = null, lastLine = "",
        projectName = project, agentName = agentName, attention = attention, isChat = false, collapsed = collapsed,
        ci = ci, lane = lane,
    )

    @Test
    fun usesTheLaneTheDesktopSent() {
        assertEquals(TaskLane.IN_PR, taskLane(agent("a", "ready", lane = "pr")))
        assertEquals(TaskLane.SNOOZED, taskLane(agent("a", "idle", lane = "snoozed")))
        // A lane from a newer desktop that this build does not know falls back to the guess.
        assertEquals(TaskLane.WORKING, taskLane(agent("a", "active", lane = "someday")))
    }

    @Test
    fun guessesTheLaneLikeThePhoneWebUiWithoutOne() {
        assertEquals(TaskLane.NEEDS_YOU, taskLane(agent("a", "needs_input")))
        assertEquals(TaskLane.NEEDS_YOU, taskLane(agent("a", "error")))
        assertEquals(TaskLane.NEEDS_YOU, taskLane(agent("a", "review")))
        assertEquals(TaskLane.NEEDS_YOU, taskLane(agent("a", "needs_input", collapsed = true)))
        assertEquals(TaskLane.SNOOZED, taskLane(agent("a", "idle", collapsed = true)))
        assertEquals(TaskLane.WORKING, taskLane(agent("a", "active")))
        assertEquals(TaskLane.STOPPED, taskLane(agent("a", "ready")))
        assertEquals(TaskLane.STOPPED, taskLane(agent("a", "idle")))
        assertEquals(TaskLane.STOPPED, taskLane(agent("a", "needs_input", running = false)))
    }

    @Test
    fun failedCiKeepsItsLaneButNeedsYouUnlessSomethingMoreUrgentShows() {
        assertEquals(TaskLane.IN_PR, taskLane(agent("a", "idle", ci = "failure", lane = "pr")))
        assertTrue(TaskFilter.NEEDS_YOU.matches(agent("a", "idle", ci = "failure", lane = "pr")))
        assertTrue(agent("a", "ready", ci = "failure").needsYou())
        assertTrue(agent("a", "idle", running = false, ci = "failure").needsYou())
        assertFalse(agent("a", "active", ci = "failure").needsYou())
        assertFalse(agent("a", "review", ci = "failure").ciFailed())
        assertFalse(agent("a", "idle", collapsed = true, ci = "failure").needsYou())
    }

    @Test
    fun labelsReadyByPrCheckStatus() {
        assertEquals("Ready to merge", readyLabel("success"))
        assertEquals("CI running", readyLabel("pending"))
        assertEquals("Ready", readyLabel(null))
        assertEquals("CI failed", agentStatusLabel(agent("a", "ready", ci = "failure")))
        assertEquals("Ready to merge", agentStatusLabel(agent("a", "ready", ci = "success")))
        assertEquals("Working", agentStatusLabel(agent("a", "active", ci = "failure")))
    }

    @Test
    fun lanesKeepTheBoardOrderAndSkipEmptyOnes() {
        val agents = listOf(
            agent("a", "active"),
            agent("b", "ready", lane = "pr"),
            agent("c", "needs_input"),
            agent("d", "active"),
            agent("e", "idle"),
        )
        val lanes = groupTasks(agents)
        assertEquals(listOf(TaskLane.NEEDS_YOU, TaskLane.STOPPED, TaskLane.WORKING, TaskLane.IN_PR), lanes.map { it.first })
        assertEquals(listOf("a", "d"), lanes[2].second.map { it.agentId })
    }

    @Test
    fun swipeOrderFollowsTheListAndSkipsMinimizedTasks() {
        val agents = listOf(
            agent("a", "active"),
            agent("b", "error", collapsed = true),
            agent("c", "review"),
            agent("d", "needs_input"),
        )
        // Review waits under Needs you, as on the desktop board.
        assertEquals(listOf("c", "d", "a"), swipeOrder(agents).map { it.agentId })
    }

    @Test
    fun filtersMatchTheirLanes() {
        assertTrue(TaskFilter.ALL.matches(agent("a", "idle")))
        assertTrue(TaskFilter.NEEDS_YOU.matches(agent("a", "error")))
        assertFalse(TaskFilter.NEEDS_YOU.matches(agent("a", "active")))
        assertTrue(TaskFilter.STOPPED.matches(agent("a", "ready")))
        assertFalse(TaskFilter.STOPPED.matches(agent("a", "needs_input")))
        assertEquals(TaskFilter.STOPPED, TaskFilter.fromKey("stopped"))
        // The old Review chip's saved key resets to All.
        assertEquals(TaskFilter.ALL, TaskFilter.fromKey("review"))
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
