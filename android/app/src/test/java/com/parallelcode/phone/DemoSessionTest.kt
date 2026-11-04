package com.parallelcode.phone

import android.app.Application
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DemoSessionTest {
    @Test
    fun viewModelRetainsTheApplicationConstructorRequiredByAndroidFactory() {
        assertNotNull(PhoneViewModel::class.java.getConstructor(Application::class.java))
    }

    @Test
    fun normalChatActionsAnswerApprovalAndQuestionAndRejectReplay() = runBlocking<Unit> {
        val client: PhoneClient = DemoSession()
        val chat = client.watchChat("demo-review")
        assertEquals(2, chat.value?.requests?.size)
        client.sendChatAction("demo-review", "respond", response("demo-approval", "accept-always"))
        assertTrue(chat.value!!.items.last().text.contains("No commands were run"))
        assertEquals("needs_input", client.agents.value.first { it.agentId == "demo-review" }.attention)
        assertEquals("This sample request is already answered.", fails {
            client.sendChatAction("demo-review", "respond", response("demo-approval", "accept"))
        }.message)
        fails { client.sendChatAction("demo-review", "respond", response("demo-question", "accept")) }
        client.sendChatAction("demo-review", "respond", response("demo-question", "accept").put("answers", JSONObject().put("greeting", "Welcome")))
        assertTrue(chat.value!!.requests.isEmpty())
        assertTrue(chat.value!!.items.last().text.contains("Welcome"))
        assertEquals("idle", client.agents.value.first { it.agentId == "demo-review" }.attention)
    }

    @Test
    fun decliningAndInterruptingUseNormalChatControls() = runBlocking<Unit> {
        val client: PhoneClient = DemoSession()
        val chat = client.watchChat("demo-review")
        client.sendChatAction("demo-review", "respond", response("demo-approval", "decline"))
        assertEquals("Sample test run declined.", chat.value!!.items.last().text)
        val working = client.watchChat("demo-working")
        assertEquals("working", working.value?.status)
        client.sendChatAction("demo-working", "interrupt")
        assertEquals("idle", working.value?.status)
        client.sendChatAction("demo-working", "send", JSONObject().put("text", "Continue"))
        assertEquals("Continue", working.value!!.items.dropLast(1).last().text)
        assertTrue(working.value!!.items.last().text.contains("no AI service"))
        assertEquals(working.value!!.items.size, working.value!!.items.map { it.id }.distinct().size)
    }

    @Test
    fun createsBothKindsOfTaskWithProjectsAndAgentChoices() = runBlocking<Unit> {
        val client: PhoneClient = DemoSession()
        assertEquals(2, client.fetchProjects().size)
        assertEquals(2, client.fetchAgentChoices().size)
        val chatId = client.createTask("demo-project", "A new chat", "Check accessibility", "demo-chat", "demo-model")
        val terminalId = client.createTask("demo-docs", "A new terminal", "Review docs", "demo-terminal")
        assertTrue(client.agents.value.first { it.taskId == chatId }.isChat)
        assertFalse(client.agents.value.first { it.taskId == terminalId }.isChat)
        assertEquals("Sample documentation", client.agents.value.first { it.taskId == terminalId }.projectName)
        assertEquals("Check accessibility", client.watchChat(chatId).value!!.items.first().text)
        assertTrue(client.getTerminalBuffer(terminalId).screen.text().contains("OFFLINE DEMO"))
        fails { client.createTask("unknown", "Bad project", "A prompt") }
        fails { client.createTask("demo-project", "Empty task", " ") }
        fails { client.sendChatAction(chatId, "send", JSONObject().put("text", " ")) }
    }

    @Test
    fun terminalInputKeysAndResizeChangeOnlyLocalBuffer() = runBlocking<Unit> {
        val client: PhoneClient = DemoSession()
        val buffer = client.getTerminalBuffer("demo-terminal")
        assertTrue(buffer.screen.text().contains("12 sample checks"))
        client.sendInput("demo-terminal", "rm -rf /sample", true, "!")
        assertTrue(buffer.screen.text().contains("rm -rf /sample"))
        assertTrue(buffer.screen.text().contains("No command executed"))
        client.sendInput("demo-terminal", "\u0003", false)
        assertTrue(buffer.screen.text().contains("Ctrl+C received"))
        client.setViewSize("demo-terminal", 42, 18)
        assertEquals(42, buffer.screen.cols)
        assertEquals(18, buffer.screen.rows)
        client.releaseViewSize("demo-terminal")
        assertEquals(80, buffer.screen.cols)
        client.releaseTerminal("demo-terminal")
        assertEquals(buffer, client.getTerminalBuffer("demo-terminal"))
        fails { client.sendInput("demo-terminal", "x".repeat(4097), true) }
    }

    @Test
    fun notesDiffMergeAndCloseUseTheNormalSafetyConfirmationPaths() = runBlocking<Unit> {
        val client: PhoneClient = DemoSession()
        val originalNotes = client.fetchNotes("demo-terminal")
        client.saveNotes("demo-terminal", "Edited sample notes")
        assertEquals("Edited sample notes", client.fetchNotes("demo-terminal"))
        assertFalse(originalNotes == client.fetchNotes("demo-terminal"))
        assertTrue(parseUnifiedDiff(client.fetchDiff("demo-terminal").diff).single().added > 0)
        assertTrue(client.fetchMergeReadiness("demo-terminal").canMerge)
        assertTrue(client.closeTask("demo-terminal", false).isNotEmpty())
        assertTrue(client.agents.value.any { it.taskId == "demo-terminal" })
        client.mergeTask("demo-terminal", squash = true, cleanup = false)
        assertEquals("", client.fetchDiff("demo-terminal").diff)
        assertFalse(client.agents.value.first { it.taskId == "demo-terminal" }.running)
        assertTrue(client.closeTask("demo-terminal", false).isEmpty())
        assertFalse(client.agents.value.any { it.taskId == "demo-terminal" })
        fails { client.fetchNotes("demo-terminal") }
        assertTrue(client.closeTask("demo-ci", true).isEmpty())
        assertFalse(client.agents.value.any { it.taskId == "demo-ci" })
    }

    @Test
    fun closedChatRefusesFurtherActions() = runBlocking<Unit> {
        val client: PhoneClient = DemoSession()
        val chat = client.watchChat("demo-working")
        assertTrue(client.closeTask("demo-working", true).isEmpty())
        assertEquals("This sample task has closed.", fails {
            client.sendChatAction("demo-working", "send", JSONObject().put("text", "Still there?"))
        }.message)
        assertEquals("closed", chat.value?.status)
        // The outgoing screen still composes after a close; like the real client, these must not throw.
        assertEquals("closed", client.watchChat("demo-working").value?.status)
        assertNotNull(client.getTerminalBuffer("demo-working"))
    }

    @Test
    fun mergeCleanupAndFixCiUpdateSamplesWithoutRunningTools() = runBlocking<Unit> {
        val client: PhoneClient = DemoSession()
        assertEquals("attention", client.fetchMergeReadiness("demo-ci").overall)
        assertNotNull(client.fetchFixCiPrompt("demo-ci"))
        client.sendFixCiPrompt("demo-ci", "Fix this sample test")
        assertEquals("success", client.agents.value.first { it.taskId == "demo-ci" }.ci)
        assertEquals(null, client.fetchFixCiPrompt("demo-ci"))
        assertTrue(client.getTerminalBuffer("demo-ci").screen.text().contains("No commands ran"))
        client.mergeTask("demo-ci", squash = false, cleanup = true)
        assertFalse(client.agents.value.any { it.taskId == "demo-ci" })
        assertTrue(client.fetchUsage().all { it.label.startsWith("Demo") })
    }

    @Test
    fun switchingPairingRenamingAndForgettingUseOnlySampleCredentials() = runBlocking<Unit> {
        val session = DemoSession()
        val originalTasks = session.agents.value
        session.switchTo(DemoSettings.SECONDARY_URL)
        assertEquals(listOf("demo-laptop"), session.agents.value.map { it.agentId })
        session.rename(DemoSettings.PRIMARY_URL, "Renamed sample")
        session.switchTo(DemoSettings.PRIMARY_URL)
        assertEquals(originalTasks, session.agents.value)
        assertEquals("Renamed sample", session.computers.value.first { it.baseUrl == DemoSettings.PRIMARY_URL }.label)
        session.addComputer()
        assertFalse(session.state.value.canControl)
        assertEquals(401, fails { session.saveNotes(session.agents.value.single().taskId, "Blocked until paired") }.status)
        fails { session.pair("000000", true) }
        session.pair("123456", false)
        assertTrue(session.state.value.canControl)
        val added = session.state.value.link!!.baseUrl
        session.forget()
        assertEquals(null, session.state.value.link)
        assertFalse(session.computers.value.any { it.baseUrl == added })
        fails { session.link(ConnectionLink("https://real.example.com", "not-a-demo-token")) }
    }

    @Test
    fun aFreshSessionDiscardsTasksMessagesSettingsNotesAndSavedComputers() = runBlocking<Unit> {
        val previous = DemoSession()
        val id = previous.createTask("demo-project", "Private sample", "Private prompt")
        previous.sendChatAction(id, "send", JSONObject().put("text", "Private reply"))
        previous.saveNotes("demo-terminal", "Private notes")
        previous.settings.quickReplies = listOf("Private quick reply")
        previous.promptHistory.record(id, "Private history")
        previous.addComputer()
        val fresh = DemoSession()
        assertEquals(5, fresh.agents.value.size)
        assertFalse(fresh.agents.value.any { it.taskId == id })
        assertFalse(fresh.fetchNotes("demo-terminal").contains("Private notes"))
        assertEquals(SettingsStore.DEFAULT_QUICK_REPLIES, fresh.settings.quickReplies)
        assertTrue(fresh.promptHistory.history(id).isEmpty())
        assertEquals(2, fresh.computers.value.size)
        assertEquals(2, fresh.watchChat("demo-review").value?.requests?.size)
        assertTrue(fresh.state.value.canControl)
    }

    @Test
    fun restoringEncryptedSampleBackupRestoresClientPairingAndComputerSelection() = runBlocking<Unit> {
        val session = DemoSession()
        session.demoSettings.createBackup("sample-pass")
        session.addComputer()
        assertFalse(session.state.value.canControl)
        session.demoSettings.restoreBackup("sample-pass")
        session.reloadComputers()
        assertEquals(DemoSettings.PRIMARY_URL, session.state.value.link?.baseUrl)
        assertTrue(session.state.value.canControl)
        assertEquals(2, session.computers.value.size)
    }

    @Test
    fun restoringPlainSampleBackupRequiresPairingAgainLikeARealBackup() = runBlocking<Unit> {
        val session = DemoSession()
        session.demoSettings.createBackup(null)
        session.demoSettings.restoreBackup(null)
        session.reloadComputers()
        assertFalse(session.state.value.canControl)
        session.pair("123456", true)
        assertTrue(session.state.value.canControl)
    }

    private fun response(id: String, decision: String) = JSONObject().put("requestId", id).put("decision", decision)
    private suspend fun fails(block: suspend () -> Unit): ApiException {
        try { block() } catch (e: ApiException) { return e }
        throw AssertionError("Expected sample API refusal")
    }
}
