package com.parallelcode.phone

import org.json.JSONArray
import org.json.JSONObject

// Mirrors AgentChatState in electron/shared/agent-chat-types.ts: the parts the phone shows.

data class ChatActivity(val type: String, val label: String, val status: String, val command: String?)

data class ChatItem(val id: String, val kind: String, val text: String, val activity: ChatActivity?)

data class ChatOption(val label: String, val description: String)

data class ChatQuestion(
    val id: String,
    val question: String,
    val isSecret: Boolean,
    val multiSelect: Boolean,
    val options: List<ChatOption>,
)

/** [id] keeps the desktop's type (string or number): the respond action must send it back as is. */
data class ChatRequest(
    val id: Any,
    val kind: String,
    val text: String,
    val action: String?,
    val details: String?,
    val questions: List<ChatQuestion>,
    val defaultToNo: Boolean,
    val canAlwaysAllow: Boolean,
    val alwaysAllowNote: String?,
)

data class ChatState(
    val status: String,
    val model: String?,
    val items: List<ChatItem>,
    val requests: List<ChatRequest>,
    val error: String?,
)

private fun JSONObject.stringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key) else null

private inline fun <T> JSONArray?.mapObjects(transform: (JSONObject) -> T): List<T> =
    if (this == null) emptyList() else List(length()) { transform(getJSONObject(it)) }

fun parseChatState(json: JSONObject) = ChatState(
    status = json.optString("status", "starting"),
    model = json.stringOrNull("model"),
    items = json.optJSONArray("items").mapObjects { item ->
        ChatItem(
            id = item.optString("id"),
            kind = item.optString("kind"),
            text = item.optString("text"),
            activity = item.optJSONObject("activity")?.let {
                ChatActivity(it.optString("type"), it.optString("label"), it.optString("status"), it.stringOrNull("command"))
            },
        )
    },
    requests = json.optJSONArray("requests").mapObjects { request ->
        ChatRequest(
            id = request.get("id"),
            kind = request.optString("kind"),
            text = request.optString("text"),
            action = request.stringOrNull("action"),
            details = request.stringOrNull("details"),
            questions = request.optJSONArray("questions").mapObjects { q ->
                ChatQuestion(
                    id = q.optString("id"),
                    question = q.optString("question"),
                    isSecret = q.optBoolean("isSecret"),
                    multiSelect = q.optBoolean("multiSelect"),
                    options = q.optJSONArray("options").mapObjects { ChatOption(it.optString("label"), it.optString("description")) },
                )
            },
            defaultToNo = request.optBoolean("defaultToNo"),
            canAlwaysAllow = request.optBoolean("canAlwaysAllow"),
            alwaysAllowNote = request.stringOrNull("alwaysAllowNote"),
        )
    },
    error = json.stringOrNull("error"),
)
