package com.parallelcode.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Parses one sample of every desktop message, written from the desktop's own protocol types by
 * electron/remote/protocol-samples.test.ts. When the desktop changes a message, the regenerated
 * samples fail here until this app follows; a message the app doesn't parse fails too.
 */
class ProtocolSamplesTest {
    private val samples: JSONObject =
        JSONObject(requireNotNull(javaClass.classLoader?.getResource("protocol-samples.json")).readText())

    private fun parse(type: String): ServerMessage =
        parseServerMessage(samples.getJSONObject(type).toString())
            ?: throw AssertionError("the app drops the desktop's '$type' message")

    @Test
    fun parsesEveryMessageTheDesktopSends() {
        for (type in samples.keys()) parse(type)
    }

    @Test
    fun readsEveryAgentField() {
        val expected = RemoteAgent(
            agentId = "agent-1",
            taskId = "task-1",
            taskName = "Fix login",
            running = true,
            exitCode = null,
            lastLine = "Running tests…",
            projectName = "web",
            agentName = "Claude Code",
            attention = "needs_input",
            isChat = true,
            collapsed = true,
            ci = "failure",
            lane = "needs",
            projectColor = "#4f8cff",
            projectIcon = "rocket",
            pr = RemotePr("https://github.com/acme/web/pull/42", "CI failed", "failed", babysit = true),
        )
        assertEquals(ServerMessage.Agents(listOf(expected)), parse("agents"))
        assertEquals(listOf(expected), parseAgentList(samples.getJSONObject("agents").getJSONArray("list").toString()))
    }

    @Test
    fun readsTerminalMessages() {
        val output = parse("output") as ServerMessage.Output
        assertEquals("agent-1", output.agentId)
        assertEquals("hello\r\n", String(output.data))

        val scrollback = parse("scrollback") as ServerMessage.Scrollback
        assertEquals(listOf("agent-1", 100, 30), listOf(scrollback.agentId, scrollback.cols, scrollback.rows))
        assertEquals("$ ls\r\nREADME.md\r\n", String(scrollback.data))

        assertEquals(ServerMessage.TerminalSize("agent-1", 120, 40), parse("terminal-size"))
        assertEquals(ServerMessage.Status("agent-1", running = false, exitCode = 2), parse("status"))
    }

    @Test
    fun readsConnectionMessages() {
        assertEquals(
            ServerMessage.Addresses(
                "http://192.168.1.20:7777",
                "http://100.101.102.103:7777",
                listOf("http://192.168.1.20:7777", "http://192.168.1.21:7777"),
            ),
            parse("addresses"),
        )
        assertEquals(ServerMessage.InputResult("r1", ok = false, error = "Not paired"), parse("input-result"))
    }

    @Test
    fun readsTheChatState() {
        val expected = ChatState(
            status = "working",
            model = "claude-opus-5-5",
            items = listOf(
                ChatItem("i1", "user", "Run the tests", null),
                ChatItem("i2", "tool", "2 passed", ChatActivity("command", "npm test", "completed", "npm test")),
            ),
            requests = listOf(
                ChatRequest(
                    id = 7,
                    kind = "approval",
                    text = "Run npm test",
                    action = "Run command",
                    details = "Bash {\"command\":\"npm test\"}",
                    questions = listOf(
                        ChatQuestion("q1", "Which suite?", isSecret = false, multiSelect = true, listOf(ChatOption("unit", "Fast tests"))),
                    ),
                    defaultToNo = true,
                    canAlwaysAllow = true,
                    alwaysAllowNote = "Writes .claude/settings.json",
                ),
            ),
            error = "Rate limited",
        )
        assertEquals(ServerMessage.Chat("agent-1", expected), parse("chat-state"))
    }
}
