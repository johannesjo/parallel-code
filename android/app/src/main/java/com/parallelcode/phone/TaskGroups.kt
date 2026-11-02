package com.parallelcode.phone

/**
 * The desktop board's lanes (src/components/task-board-lanes.ts), top to bottom in the board's
 * left-to-right order, so a task sits under the same heading on the computer and the phone.
 */
enum class TaskLane(val key: String, val label: String) {
    NEEDS_YOU("needs", "Needs you"),
    STOPPED("stopped", "Stopped"),
    WORKING("working", "Working"),
    IN_PR("pr", "In pull request"),
    SNOOZED("snoozed", "Snoozed & minimized"),
}

/** The list's filter chips, as in the phone web UI; [ALL] shows every lane. */
enum class TaskFilter(val key: String, val label: String) {
    ALL("all", "All"),
    NEEDS_YOU("needs", "Needs you"),
    STOPPED("stopped", "Stopped");

    companion object {
        fun fromKey(key: String?): TaskFilter = entries.firstOrNull { it.key == key } ?: ALL
    }
}

/**
 * Failed PR checks need you once the agent has nothing more urgent to say: a question, an error,
 * work in progress or a review flag still wins.
 */
fun RemoteAgent.ciFailed(): Boolean =
    !collapsed && ci == "failure" && (attention == "idle" || attention == "ready")

fun RemoteAgent.needsYou(): Boolean =
    (running && (attention == "needs_input" || attention == "error")) || ciFailed()

/** `ready` only knows nothing failed; the PR checks say whether it can actually merge. */
fun readyLabel(ci: String?): String = when (ci) {
    "success" -> "Ready to merge"
    "pending" -> "CI running"
    else -> "Ready"
}

/**
 * The lane the desktop put the task in. An older desktop sends none, so this guesses the same way
 * the phone web UI does (`laneOf` in src/remote/AgentList.tsx).
 */
fun taskLane(agent: RemoteAgent): TaskLane {
    TaskLane.entries.firstOrNull { it.key == agent.lane }?.let { return it }
    return when {
        (agent.running && agent.attention in setOf("needs_input", "error")) || agent.attention == "review" ->
            TaskLane.NEEDS_YOU
        agent.collapsed -> TaskLane.SNOOZED
        agent.running && agent.attention == "active" -> TaskLane.WORKING
        else -> TaskLane.STOPPED
    }
}

fun TaskFilter.matches(agent: RemoteAgent): Boolean = when (this) {
    TaskFilter.ALL -> true
    // Failed CI keeps its PR lane, as on the board, but still needs you.
    TaskFilter.NEEDS_YOU -> taskLane(agent) == TaskLane.NEEDS_YOU || agent.ciFailed()
    TaskFilter.STOPPED -> taskLane(agent) == TaskLane.STOPPED
}

/** Whether the task name, project, or agent contains [query], ignoring case and surrounding space. */
fun matchesSearch(agent: RemoteAgent, query: String): Boolean {
    val q = query.trim()
    if (q.isEmpty()) return true
    return listOfNotNull(agent.taskName, agent.projectName, agent.agentName)
        .any { it.contains(q, ignoreCase = true) }
}

/** Non-empty lanes in display order; each keeps the desktop's order within it. */
fun groupTasks(agents: List<RemoteAgent>): List<Pair<TaskLane, List<RemoteAgent>>> {
    val byLane = agents.groupBy(::taskLane)
    return TaskLane.entries.mapNotNull { lane -> byLane[lane]?.let { lane to it } }
}

/**
 * The active tasks in the order the list shows them: the order swiping between tasks follows.
 * Minimized tasks are left out, so a swipe never lands on one.
 */
fun swipeOrder(agents: List<RemoteAgent>): List<RemoteAgent> =
    groupTasks(agents.filter { !it.collapsed }).flatMap { it.second }

/**
 * The next task, after [currentAgentId] in list order and wrapping around, that needs you;
 * null when no other one does.
 */
fun nextTaskNeedingYou(agents: List<RemoteAgent>, currentAgentId: String): RemoteAgent? {
    val order = swipeOrder(agents)
    val start = order.indexOfFirst { it.agentId == currentAgentId }
    return (1..order.size)
        .map { order[(start + it).mod(order.size)] }
        .firstOrNull { it.agentId != currentAgentId && it.needsYou() }
}
