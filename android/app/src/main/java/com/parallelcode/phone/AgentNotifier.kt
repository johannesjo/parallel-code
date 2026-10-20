package com.parallelcode.phone

/** An agent change worth a notification. */
enum class AgentEvent { NEEDS_INPUT, ERROR, FINISHED }

data class AgentNotice(val agent: RemoteAgent, val event: AgentEvent)

private val BUSY = setOf("active", "shell_busy")
private val SETTLED = setOf("ready", "review", "idle")

/**
 * Turns successive agent lists into notices. The first list is the baseline: agents already
 * waiting when watching starts are not announced.
 */
class AgentNotifier {
    private var previous: Map<String, RemoteAgent>? = null

    fun update(agents: List<RemoteAgent>): List<AgentNotice> {
        val before = previous
        previous = agents.associateBy { it.agentId }
        if (before == null) return emptyList()
        return agents.mapNotNull { agent ->
            val old = before[agent.agentId] ?: return@mapNotNull null
            eventFor(old, agent)?.let { AgentNotice(agent, it) }
        }
    }
}

internal fun eventFor(old: RemoteAgent, new: RemoteAgent): AgentEvent? = when {
    new.collapsed -> null
    new.attention == old.attention && new.running == old.running -> null
    new.attention == "needs_input" -> AgentEvent.NEEDS_INPUT
    new.attention == "error" -> AgentEvent.ERROR
    old.running && !new.running -> AgentEvent.FINISHED
    old.attention in BUSY && new.attention in SETTLED -> AgentEvent.FINISHED
    else -> null
}
