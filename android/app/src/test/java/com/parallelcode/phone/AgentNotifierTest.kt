package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentNotifierTest {
    private fun agent(attention: String, running: Boolean = true, collapsed: Boolean = false) = RemoteAgent(
        agentId = "a",
        taskId = "t",
        taskName = "Task",
        running = running,
        exitCode = null,
        lastLine = "",
        projectName = null,
        agentName = "Claude Code",
        attention = attention,
        isChat = false,
        collapsed = collapsed,
    )

    @Test
    fun firstListIsTheBaseline() {
        assertTrue(AgentNotifier().update(listOf(agent("needs_input"))).isEmpty())
    }

    @Test
    fun announcesNeedsInputErrorsAndFinishing() {
        val notifier = AgentNotifier()
        notifier.update(listOf(agent("active")))
        assertEquals(listOf(AgentEvent.NEEDS_INPUT), notifier.update(listOf(agent("needs_input"))).map { it.event })
        assertEquals(listOf(AgentEvent.ERROR), notifier.update(listOf(agent("error"))).map { it.event })
        notifier.update(listOf(agent("active")))
        assertEquals(listOf(AgentEvent.FINISHED), notifier.update(listOf(agent("ready"))).map { it.event })
        notifier.update(listOf(agent("active")))
        assertEquals(
            listOf(AgentEvent.FINISHED),
            notifier.update(listOf(agent("active", running = false))).map { it.event },
        )
    }

    @Test
    fun staysQuietForUnchangedMinimizedOrNewAgents() {
        val notifier = AgentNotifier()
        notifier.update(listOf(agent("needs_input")))
        assertTrue(notifier.update(listOf(agent("needs_input"))).isEmpty())
        assertTrue(notifier.update(listOf(agent("error", collapsed = true))).isEmpty())
        assertTrue(notifier.update(listOf(agent("active"), agent("needs_input").copy(agentId = "b"))).isEmpty())
    }
}
