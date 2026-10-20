package com.parallelcode.phone

import android.content.SharedPreferences
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject

/**
 * Messages this phone has sent, per agent, newest first. Powers prompt recall in the
 * composers: tapping a past message puts it back in the draft, ready to edit or send.
 * Bounded so it cannot grow without limit (see [MAX_PER_AGENT] and [MAX_AGENTS]).
 */
class PromptHistoryStore(private val prefs: SharedPreferences) {

    /** Past messages sent to [agentId], newest first. */
    fun history(agentId: String): List<String> = read()[agentId].orEmpty()

    /** Remember a sent message; blanks are ignored and repeats move back to the front. */
    fun record(agentId: String, message: String) {
        val text = message.trim().take(MAX_MESSAGE_LENGTH)
        if (text.isEmpty()) return
        val all = read().toMutableMap()
        all[agentId] = ((listOf(text) + all[agentId].orEmpty()).distinct()).take(MAX_PER_AGENT)
        while (all.size > MAX_AGENTS) all.remove(all.keys.first())
        write(all)
    }

    private fun read(): Map<String, List<String>> {
        val root = runCatching { JSONObject(prefs.getString(KEY_HISTORY, "{}") ?: "{}") }.getOrElse { JSONObject() }
        return LinkedHashMap<String, List<String>>().also { out ->
            root.keys().forEach { id ->
                val list = root.optJSONArray(id) ?: return@forEach
                out[id] = List(list.length()) { list.optString(it) }.filter { it.isNotEmpty() }
            }
        }
    }

    private fun write(all: Map<String, List<String>>) {
        val root = JSONObject()
        all.forEach { (id, messages) -> root.put(id, JSONArray(messages)) }
        prefs.edit { putString(KEY_HISTORY, root.toString()) }
    }

    companion object {
        const val PREFS_NAME = "promptHistory"
        const val KEY_HISTORY = "history"
        /** Past messages kept per agent. */
        const val MAX_PER_AGENT = 20
        /** Agents kept at all; the least recently recorded falls off. */
        const val MAX_AGENTS = 50
        /** Very long pastes are trimmed so one giant message cannot crowd out the rest. */
        const val MAX_MESSAGE_LENGTH = 2000
    }
}
