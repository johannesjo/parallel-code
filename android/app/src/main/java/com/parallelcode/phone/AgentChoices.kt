package com.parallelcode.phone

import org.json.JSONArray

/** A model the desktop lets a phone pick for an agent; [label] is what to show. */
data class AgentModel(val id: String, val label: String)

/**
 * An agent the phone may start a task with. [models] is empty for an agent that
 * only runs with the model its desktop settings configure.
 */
data class MobileAgentChoice(
    val id: String,
    val name: String,
    val isDefault: Boolean,
    val models: List<AgentModel>,
)

/** Parsing for the desktop's agent list (GET /api/mobile/agents). */
internal fun parseAgentChoices(raw: String): List<MobileAgentChoice> {
    val list = JSONArray(raw)
    return List(list.length()) { i ->
        val agent = list.getJSONObject(i)
        val models = agent.optJSONArray("models") ?: JSONArray()
        MobileAgentChoice(
            id = agent.getString("id"),
            name = agent.getString("name"),
            isDefault = agent.optBoolean("isDefault", false),
            models = List(models.length()) { j ->
                val model = models.getJSONObject(j)
                val id = model.getString("id")
                AgentModel(id, model.optString("label").ifEmpty { id })
            },
        )
    }
}
