package com.parallelcode.phone

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProtocolTest {
    @Test
    fun parsesTheAgentList() {
        val msg = parseServerMessage(
            """{"type":"agents","list":[{"agentId":"a1","taskId":"t1","taskName":"Fix login",
            "status":"running","exitCode":null,"lastLine":"thinking","projectName":"web",
            "attention":"needs_input"},{"agentId":"c1","taskId":"t2","taskName":"Chat",
            "status":"exited","exitCode":0,"lastLine":"","attention":"idle","kind":"chat"}]}""",
        ) as ServerMessage.Agents
        val (terminal, chat) = msg.list
        assertEquals("Fix login", terminal.taskName)
        assertEquals(true, terminal.running)
        assertNull(terminal.exitCode)
        assertEquals("web", terminal.projectName)
        assertNull(terminal.agentName)
        assertEquals("needs_input", terminal.attention)
        assertEquals(false, terminal.isChat)
        assertEquals(false, terminal.collapsed)
        assertEquals(0, chat.exitCode)
        assertEquals(true, chat.isChat)
        assertEquals(false, chat.collapsed)
    }

    @Test
    fun parsesCollapsedAgents() {
        val msg = parseServerMessage(
            """{"type":"agents","list":[{"agentId":"collapsed:t3","taskId":"t3","taskName":"Old Task",
            "status":"exited","exitCode":null,"lastLine":"Done","attention":"idle","collapsed":true}]}""",
        ) as ServerMessage.Agents
        val (agent) = msg.list
        assertEquals("Old Task", agent.taskName)
        assertEquals(true, agent.collapsed)
        assertEquals(false, agent.running)
    }

    @Test
    fun decodesTerminalData() {
        val scrollback = parseServerMessage(
            """{"type":"scrollback","agentId":"a1","data":"aGk=","cols":100}""",
        ) as ServerMessage.Scrollback
        assertArrayEquals("hi".toByteArray(), scrollback.data)
        assertEquals(100, scrollback.cols)
        assertEquals(24, scrollback.rows)
    }

    @Test
    fun parsesInputResults() {
        assertEquals(
            ServerMessage.InputResult("7", false, "busy"),
            parseServerMessage("""{"type":"input-result","requestId":"7","ok":false,"error":"busy"}"""),
        )
    }

    @Test
    fun ignoresUnknownAndMalformedMessages() {
        assertNull(parseServerMessage("""{"type":"mystery","agentId":"a"}"""))
        assertNull(parseServerMessage("""{"type":"chat-state","agentId":"a"}"""))
        assertNull(parseServerMessage("""{"type":"output","agentId":"a"}"""))
        assertNull(parseServerMessage("nope"))
    }

    @Test
    fun parsesChatStateWithRequestsKeepingTheirIdType() {
        val msg = parseServerMessage(
            """{"type":"chat-state","agentId":"a","state":{"status":"ready","model":"opus",
            "items":[{"id":"1","kind":"user","text":"hi"},
              {"id":"2","kind":"tool","text":"out","activity":{"type":"command","label":"Run","status":"failed","command":"ls"}}],
            "requests":[{"id":7,"since":0,"kind":"question","text":"","questions":[
              {"id":"q","question":"Which?","isSecret":false,"multiSelect":true,
               "options":[{"label":"A","description":""}]}]}]}}""",
        ) as ServerMessage.Chat
        assertEquals("a", msg.agentId)
        assertEquals(listOf("user", "tool"), msg.state.items.map { it.kind })
        assertEquals("ls", msg.state.items[1].activity?.command)
        val request = msg.state.requests.single()
        assertEquals(7, request.id)
        assertEquals(true, request.questions.single().multiSelect)
        assertEquals("A", request.questions.single().options.single().label)
    }

    @Test
    fun preparesRepliesLikeThePhoneWebUi() {
        assertEquals("one two", messageForTerminal(" one\r\ntwo\u0003 ", bracketedPaste = false))
        assertEquals("\u001b[200~one\ntwo\u001b[201~", messageForTerminal("one\rtwo", bracketedPaste = true))
        assertEquals("", messageForTerminal(" \u001b ", bracketedPaste = true))
    }
}
