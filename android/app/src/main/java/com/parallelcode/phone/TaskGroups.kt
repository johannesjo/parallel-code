package com.parallelcode.phone

/**
 * How the task list sorts and narrows its agents, as the phone web UI (`src/remote/AgentList.tsx`)
 * does: the tasks that need you first, then the working ones, the ones ready to review, and the rest.
 */
enum class TaskGroup(val label: String) {
    NEEDS_YOU("Needs you"),
    WORKING("Working"),
    REVIEW("Ready to review"),
    OTHER("Other tasks"),
}

/** The list's filter chips; [ALL] shows every group. */
enum class TaskFilter(val key: String, val label: String) {
    ALL("all", "All"),
    NEEDS_YOU("attention", "Needs you"),
    REVIEW("review", "Review");

    companion object {
        fun fromKey(key: String?): TaskFilter = entries.firstOrNull { it.key == key } ?: ALL
    }
}

fun RemoteAgent.needsYou(): Boolean = running && (attention == "needs_input" || attention == "error")

fun taskGroup(agent: RemoteAgent): TaskGroup = when {
    agent.needsYou() -> TaskGroup.NEEDS_YOU
    !agent.running -> TaskGroup.OTHER
    agent.attention == "active" -> TaskGroup.WORKING
    agent.attention == "review" || agent.attention == "ready" -> TaskGroup.REVIEW
    else -> TaskGroup.OTHER
}

fun TaskFilter.matches(agent: RemoteAgent): Boolean = when (this) {
    TaskFilter.ALL -> true
    TaskFilter.NEEDS_YOU -> taskGroup(agent) == TaskGroup.NEEDS_YOU
    TaskFilter.REVIEW -> taskGroup(agent) == TaskGroup.REVIEW
}

/** Whether the task name, project, or agent contains [query], ignoring case and surrounding space. */
fun matchesSearch(agent: RemoteAgent, query: String): Boolean {
    val q = query.trim()
    if (q.isEmpty()) return true
    return listOfNotNull(agent.taskName, agent.projectName, agent.agentName)
        .any { it.contains(q, ignoreCase = true) }
}

/** Non-empty groups in display order; each keeps the desktop's order within it. */
fun groupTasks(agents: List<RemoteAgent>): List<Pair<TaskGroup, List<RemoteAgent>>> {
    val byGroup = agents.groupBy(::taskGroup)
    return TaskGroup.entries.mapNotNull { group -> byGroup[group]?.let { group to it } }
}

/**
 * The tasks in the order the list shows them, minimized ones last: the order swiping between
 * tasks follows.
 */
fun taskListOrder(agents: List<RemoteAgent>): List<RemoteAgent> =
    groupTasks(agents.filter { !it.collapsed }).flatMap { it.second } + agents.filter { it.collapsed }

/**
 * The next task, after [currentAgentId] in list order and wrapping around, that needs you;
 * null when no other one does.
 */
fun nextTaskNeedingYou(agents: List<RemoteAgent>, currentAgentId: String): RemoteAgent? {
    val order = taskListOrder(agents).filter { !it.collapsed }
    val start = order.indexOfFirst { it.agentId == currentAgentId }
    return (1..order.size)
        .map { order[(start + it).mod(order.size)] }
        .firstOrNull { it.agentId != currentAgentId && it.needsYou() }
}
