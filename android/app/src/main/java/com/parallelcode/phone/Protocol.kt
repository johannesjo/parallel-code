package com.parallelcode.phone

import org.json.JSONArray
import org.json.JSONObject

// Mirrors the server messages in electron/remote/protocol.ts that this app uses.

data class RemoteAgent(
    val agentId: String,
    val taskId: String,
    val taskName: String,
    val running: Boolean,
    val exitCode: Int?,
    val lastLine: String,
    val projectName: String?,
    val agentName: String?,
    /** Renderer-derived status such as `needs_input`, `active` or `idle`. */
    val attention: String,
    /** The desktop's built-in chat has no terminal to stream. */
    val isChat: Boolean,
    val collapsed: Boolean = false,
    /** The task's open PR checks: `pending`, `failure` or `success`; null without one. */
    val ci: String? = null,
    /** The desktop board lane: `needs`, `stopped`, `working`, `pr` or `snoozed`; null from older desktops. */
    val lane: String? = null,
    /** The project's color as CSS, e.g. `#4f8cff` or `hsl(210, 80%, 60%)`; null when unknown. */
    val projectColor: String? = null,
    /** The project's icon id, drawn from [ProjectIcons]; null for the plain colour square. */
    val projectIcon: String? = null,
    /** The task's open pull request as the desktop board card shows it. */
    val pr: RemotePr? = null,
)

/** Mirrors `RemoteTaskPr`: the board card's PR row. */
data class RemotePr(
    val url: String,
    /** The board's status line, such as "CI failed" or "CI passed · Review needed". */
    val label: String?,
    /** `merged`, `ready`, `blocked`, `running` or `failed`; null before checks report. */
    val kind: String?,
    val babysit: Boolean,
) {
    /** The number in `…/pull/123`. */
    val number: String? get() = Regex("/pull/(\\d+)").find(url)?.groupValues?.get(1)
}

sealed interface ServerMessage {
    data class Agents(val list: List<RemoteAgent>) : ServerMessage
    data class Output(val agentId: String, val data: ByteArray) : ServerMessage
    data class Scrollback(val agentId: String, val data: ByteArray, val cols: Int, val rows: Int) :
        ServerMessage
    data class Status(val agentId: String, val running: Boolean, val exitCode: Int?) : ServerMessage
    data class InputResult(val requestId: String, val ok: Boolean, val error: String?) :
        ServerMessage
    data class Chat(val agentId: String, val state: ChatState) : ServerMessage
}

private fun JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key) else null

private fun JSONObject.optIntOrNull(key: String): Int? =
    if (has(key) && !isNull(key)) optInt(key) else null

private fun decodeBase64(data: String): ByteArray = java.util.Base64.getDecoder().decode(data)

/** Returns null for messages this app ignores and for malformed ones. */
fun parseServerMessage(raw: String): ServerMessage? = try {
    val msg = JSONObject(raw)
    when (msg.getString("type")) {
        "agents" -> {
            val list = msg.getJSONArray("list")
            ServerMessage.Agents(List(list.length()) { i -> parseAgent(list.getJSONObject(i)) })
        }
        "output" -> ServerMessage.Output(msg.getString("agentId"), decodeBase64(msg.getString("data")))
        "scrollback" -> ServerMessage.Scrollback(
            msg.getString("agentId"),
            decodeBase64(msg.getString("data")),
            msg.getInt("cols"),
            msg.optInt("rows", 24),
        )
        "status" -> ServerMessage.Status(
            msg.getString("agentId"),
            msg.getString("status") == "running",
            msg.optIntOrNull("exitCode"),
        )
        "chat-state" -> ServerMessage.Chat(msg.getString("agentId"), parseChatState(msg.getJSONObject("state")))
        "input-result" -> ServerMessage.InputResult(
            msg.getString("requestId"),
            msg.getBoolean("ok"),
            msg.optStringOrNull("error"),
        )
        else -> null
    }
} catch (_: Exception) {
    null
}

/** The desktop's `GET /api/agents` reply; null when malformed. */
fun parseAgentList(raw: String): List<RemoteAgent>? = try {
    val list = JSONArray(raw)
    List(list.length()) { i -> parseAgent(list.getJSONObject(i)) }
} catch (_: Exception) {
    null
}

private fun parseAgent(a: JSONObject) = RemoteAgent(
    agentId = a.getString("agentId"),
    taskId = a.getString("taskId"),
    taskName = a.getString("taskName"),
    running = a.getString("status") == "running",
    exitCode = a.optIntOrNull("exitCode"),
    lastLine = a.optString("lastLine"),
    projectName = a.optStringOrNull("projectName"),
    agentName = a.optStringOrNull("agentName"),
    attention = a.optString("attention", "idle"),
    isChat = a.optString("kind") == "chat",
    collapsed = a.optBoolean("collapsed", false),
    ci = a.optStringOrNull("ci"),
    lane = a.optStringOrNull("lane"),
    projectColor = a.optStringOrNull("projectColor")?.takeIf { it.isNotBlank() },
    projectIcon = a.optStringOrNull("projectIcon"),
    pr = a.optJSONObject("pr")?.let(::parsePr),
)

private fun parsePr(p: JSONObject): RemotePr? {
    val url = p.optStringOrNull("url") ?: return null
    return RemotePr(url, p.optStringOrNull("label"), p.optStringOrNull("kind"), p.optBoolean("babysit", false))
}

/**
 * Prepares a reply the way the phone web UI does (src/remote/terminalText.ts): control characters
 * must not escape the pasted region or submit midway.
 */
fun messageForTerminal(text: String, bracketedPaste: Boolean): String {
    val clean = text
        .replace(Regex("\r\n?"), "\n")
        .replace(Regex("[\\x00-\\x08\\x0b-\\x1f\\x7f]"), "")
        .trim()
    if (clean.isEmpty()) return ""
    return if (bracketedPaste) "\u001b[200~$clean\u001b[201~" else clean.replace('\n', ' ')
}
