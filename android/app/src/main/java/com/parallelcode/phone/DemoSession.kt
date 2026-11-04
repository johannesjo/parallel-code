package com.parallelcode.phone

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/**
 * Offline implementation of the normal phone session. It has no Context, transport, real
 * credentials or coroutine scope. All actions change only these samples and memory stores.
 */
internal class DemoSession : PhoneClient {
    val demoSettings = DemoSettings()
    val settings = demoSettings.settings
    val promptHistory = demoSettings.history
    private val credentials = demoSettings.credentials
    private var nextId = 0
    private val _state = MutableStateFlow(ConnectionState(credentials.link, ConnectionStatus.CONNECTED, canControl = true))
    override val state = _state.asStateFlow()
    private val _computers = MutableStateFlow(credentials.computers)
    override val computers = _computers.asStateFlow()
    override val latencyMs = MutableStateFlow<Long?>(null).asStateFlow()
    private val byComputer = mutableMapOf<String, List<RemoteAgent>>()
    private val _agents = MutableStateFlow(samples())
    override val agents = _agents.asStateFlow()
    private val chats = mutableMapOf<String, MutableStateFlow<ChatState?>>()
    private val notes = mutableMapOf<String, String>()
    private val diffs = mutableMapOf<String, TaskDiff>()
    private val terminals = mutableMapOf<String, TerminalBuffer>()
    private val usage = listOf(
        ProviderUsage("Demo subscription", UsageWindow(32.0, null), UsageWindow(18.0, null), "ready", null),
        ProviderUsage("Demo credits", null, null, "ready", null, CreditUsage(2.50, 20.0, "USD", 12.5)),
    )

    init {
        chats["demo-review"] = MutableStateFlow(chat("Review the sample welcome screen and answer the requests below.").copy(
            requests = listOf(
                ChatRequest("demo-approval", "approval", "Run the sample tests?", "Run tests",
                    "Offline simulation: no commands will run.", emptyList(), false, true, "apply only to this demo session"),
                ChatRequest("demo-question", "question", "Choose a welcome message", null, null,
                    listOf(ChatQuestion("greeting", "Which greeting should the sample use?", false, false,
                        listOf(ChatOption("Welcome", "A short greeting"), ChatOption("Hello", "A friendly greeting")))),
                    false, false, null),
            ),
        ))
        chats["demo-working"] = MutableStateFlow(chat("Simulated agent is working. Tap Stop to interrupt, then send another message.").copy(status = "working"))
        byComputer[DemoSettings.SECONDARY_URL] = listOf(agent("demo-laptop", "Review laptop documentation", false, "idle", "Sample laptop ready"))
    }

    override fun start(holder: String) = Unit
    override fun stop(holder: String) = Unit
    override fun onVpnPolicyChanged() = Unit
    override fun pauseViewSize() = Unit
    override fun resumeViewSize() = Unit
    override fun reconnect() {
        _state.value = _state.value.copy(status = ConnectionStatus.CONNECTED)
    }

    /** Demo setup deliberately accepts only reserved sample addresses, never user endpoints. */
    override fun link(link: ConnectionLink) {
        if (!link.baseUrl.endsWith(".demo.invalid")) throw ApiException("Use the offline sample computer.")
        saveCurrentComputer()
        credentials.saveLink(ConnectionLink(link.baseUrl, "demo-only"))
        selectCurrentComputer()
    }

    fun addComputer() {
        link(ConnectionLink("https://computer-${++nextId}.demo.invalid", "demo-only"))
    }

    override fun switchTo(baseUrl: String) {
        saveCurrentComputer()
        credentials.select(baseUrl)
        selectCurrentComputer()
    }

    override fun rename(baseUrl: String, alias: String?) {
        credentials.rename(baseUrl, alias)
        _computers.value = credentials.computers
    }

    override fun forget(baseUrl: String?) {
        if (baseUrl == null) return
        val active = state.value.link?.baseUrl == baseUrl
        credentials.remove(baseUrl)
        byComputer.remove(baseUrl)
        _computers.value = credentials.computers
        if (active) {
            _agents.value = emptyList()
            _state.value = ConnectionState()
        }
    }

    fun reloadComputers() {
        saveCurrentComputer()
        selectCurrentComputer()
    }

    private fun saveCurrentComputer() {
        state.value.link?.baseUrl?.let { byComputer[it] = _agents.value }
    }

    private fun selectCurrentComputer() {
        _computers.value = credentials.computers
        val link = credentials.link
        _state.value = ConnectionState(link, if (link == null) ConnectionStatus.DISCONNECTED else ConnectionStatus.CONNECTED,
            canControl = credentials.pairedToken != null)
        _agents.value = link?.let { byComputer.getOrPut(it.baseUrl) {
            listOf(agent("demo-computer-${++nextId}", "Explore the sample terminal", false, "idle", "Offline sample ready"))
        } }.orEmpty()
    }

    override suspend fun pair(pin: String, remember: Boolean) {
        if (pin != "123456") throw ApiException("For this local simulation, enter 123456.")
        credentials.savePairedToken("demo-paired-only")
        _computers.value = credentials.computers
        _state.value = state.value.copy(canControl = true)
    }

    override suspend fun fetchProjects() = listOf(
        MobileProject("demo-project", "Sample project", "Demo chat agent", color = "hsl(210, 70%, 60%)"),
        MobileProject("demo-docs", "Sample documentation", "Demo terminal agent", color = "hsl(150, 55%, 50%)"),
    )

    override suspend fun fetchAgentChoices() = listOf(
        MobileAgentChoice("demo-chat", "Demo chat agent", true, listOf(AgentModel("demo-model", "Sample model (offline)"))),
        MobileAgentChoice("demo-terminal", "Demo terminal agent", false, emptyList()),
    )

    override suspend fun createTask(projectId: String, name: String, prompt: String, agentId: String?, model: String?): String {
        requireControl()
        if (prompt.isBlank() || name.isBlank()) throw ApiException("Describe the sample task first.")
        if (fetchProjects().none { it.id == projectId }) throw ApiException("Choose a sample project.")
        val id = "demo-created-${++nextId}"
        val isChat = agentId != "demo-terminal"
        _agents.value += agent(id, name.trim(), isChat, "idle", "Sample task created").copy(
            projectName = if (projectId == "demo-docs") "Sample documentation" else "Sample project",
        )
        chats[id] = MutableStateFlow(chat("Sample task created locally. No agent was launched.").copy(
            items = listOf(item("user", prompt.trim()), item("assistant", "Sample task created locally. Send a message to try a reply.")),
        ))
        return id
    }

    override suspend fun fetchNotes(taskId: String): String {
        task(taskId)
        return notes.getOrPut(taskId) { "# Sample task notes\n\nReview accessibility, then run the sample tests. Edits stay in this demo." }
    }

    override suspend fun saveNotes(taskId: String, notes: String) {
        requireControl()
        task(taskId)
        this.notes[taskId] = notes
    }

    override suspend fun fetchDiff(taskId: String): TaskDiff {
        task(taskId)
        return diffs[taskId] ?: TaskDiff(SAMPLE_DIFF, false, false)
    }

    override suspend fun fetchUsage() = usage

    override suspend fun fetchMergeReadiness(taskId: String): MergeReadiness {
        val task = task(taskId)
        return MergeReadiness(if (task.ci == "failure") "attention" else "ready", true, "main", "demo/${task.taskId}", listOf(
            ReadinessCheck("Working tree", "pass", "Sample changes are committed locally in this simulation."),
            ReadinessCheck("Conflicts", "pass", "No sample conflicts."),
            ReadinessCheck("CI", if (task.ci == "failure") "warning" else "pass",
                if (task.ci == "failure") "Sample check failed. Try Fix CI before merging." else "12 sample tests passed."),
        ))
    }

    override suspend fun mergeTask(taskId: String, squash: Boolean, cleanup: Boolean) {
        requireControl()
        task(taskId)
        diffs[taskId] = TaskDiff("", false, false)
        if (cleanup) removeTask(taskId) else updateTask(taskId) {
            it.copy(running = false, exitCode = 0, attention = "idle", ci = "success", lastLine = "Sample merge complete; no Git operation ran")
        }
    }

    override suspend fun fetchFixCiPrompt(taskId: String): String? =
        if (task(taskId).ci == "failure") "Offline sample CI failure: welcome.test.ts expected 'Welcome', received 'Hello'.\nUpdate the sample greeting and rerun its tests." else null

    override suspend fun sendFixCiPrompt(taskId: String, prompt: String) {
        requireControl()
        if (prompt.isBlank() || prompt.length > MAX_FIX_CI_PROMPT_LENGTH) throw ApiException("Enter a sample fix prompt.")
        val task = task(taskId)
        if (task.isChat) sendChatAction(task.agentId, "send", JSONObject().put("text", prompt))
        else appendTerminal(task.agentId, "\r\nDemo Fix CI prompt received: $prompt\r\n12 sample tests passed. No commands ran.\r\n")
        updateTask(taskId) { it.copy(ci = "success", attention = "idle", lastLine = "Sample CI fixed; no workflow ran") }
    }

    override suspend fun closeTask(taskId: String, force: Boolean): List<String> {
        requireControl()
        task(taskId)
        if (!force && fetchDiff(taskId).diff.isNotEmpty()) return listOf("This sample has unmerged changes. Closing removes only its demo data.")
        removeTask(taskId)
        return emptyList()
    }

    private fun removeTask(taskId: String) {
        _agents.value = agents.value.filterNot { it.taskId == taskId }
        chats[taskId]?.let { it.value = it.value?.copy(status = "closed", requests = emptyList()) }
        terminals.remove(taskId)
        notes.remove(taskId)
        diffs.remove(taskId)
    }

    // Screens animating out still read a just-closed task; like RemoteClient, never throw here.
    override fun getTerminalBuffer(agentId: String): TerminalBuffer {
        return terminals.getOrPut(agentId) {
            TerminalBuffer(agentId).also { it.onScrollback((
                "Parallel Code — OFFLINE DEMO\r\n" +
                "No shell, desktop or AI service is connected.\r\n\r\n" +
                "Reviewing sample welcome.ts…\r\n" +
                (if (findTask(agentId)?.ci == "failure") "\u001b[31mFAIL\u001b[0m welcome.test.ts (sample CI)\r\n\r\n"
                    else "\u001b[32mPASS\u001b[0m 12 sample checks\r\n\r\n") +
                "Type a reply, try quick keys, or open Notes and Changes.\r\n" +
                "Commands are displayed only; they never execute.\r\n> "
            ).toByteArray(), 80, 24) }
        }
    }

    private fun appendTerminal(agentId: String, text: String) = getTerminalBuffer(agentId).onOutput(text.toByteArray())
    override fun releaseTerminal(agentId: String) = Unit
    override fun setViewSize(agentId: String, cols: Int, rows: Int) { getTerminalBuffer(agentId).resize(cols.coerceIn(10, 300), rows.coerceIn(5, 150)) }
    override fun releaseViewSize(agentId: String) { terminals[agentId]?.resize(80, 24) }
    override fun scrollTerminal(agentId: String, lines: Int) = Unit

    override suspend fun sendInput(agentId: String, data: String, submit: Boolean, prefixKey: String?) {
        requireControl()
        task(agentId)
        if (data.length > 4096) throw ApiException("This message is too long. Shorten it and try again.")
        // Never feed arbitrary escape sequences into the sample terminal. Show controls by name.
        val display = data.map { if (it.isISOControl()) ' ' else it }.joinToString("").trim()
        if (display.isEmpty()) {
            val key = when (data) { "\u0003" -> "Ctrl+C"; "\u001b" -> "Escape"; "\r" -> "Enter"; "\t" -> "Tab"; else -> "control key" }
            appendTerminal(agentId, "\r\n[Demo $key received]\r\n> ")
        } else {
            appendTerminal(agentId, "${prefixKey.orEmpty()}$display" + if (submit) "\r\nDemo reply received. No command executed.\r\n> " else "\r\n[Demo key received]\r\n> ")
        }
        updateTask(agentId) { it.copy(attention = "idle", lastLine = "Demo terminal input received") }
    }

    override fun watchChat(agentId: String): StateFlow<ChatState?> {
        return chats.getOrPut(agentId) { MutableStateFlow(chat("This offline conversation is ready for your reply.")) }.asStateFlow()
    }
    override fun unwatchChat(agentId: String) = Unit

    override suspend fun sendChatAction(agentId: String, action: String, params: JSONObject) {
        requireControl()
        task(agentId)
        val flow = chats[agentId] ?: throw ApiException("Unknown sample conversation.")
        val current = flow.value ?: throw ApiException("Sample conversation is not ready.")
        when (action) {
            "send" -> {
                val text = params.optString("text").trim()
                if (text.isEmpty()) throw ApiException("Write a message first.")
                if (text.length > 60_000) throw ApiException("This sample message is too long.")
                flow.value = current.copy(status = "idle", items = current.items + listOf(item("user", text),
                    item("assistant", "Demo reply received. Your message stays on this phone; no AI service was called.")))
            }
            "interrupt" -> flow.value = current.copy(status = "idle", items = current.items + item("assistant", "Sample work interrupted. No real process was stopped."))
            "respond" -> {
                val request = current.requests.firstOrNull { it.id == params.opt("requestId") }
                    ?: throw ApiException("This sample request is already answered.")
                val decision = params.optString("decision")
                if (decision !in listOf("accept", "accept-always", "decline")) throw ApiException("Choose a sample response.")
                val answers = params.optJSONObject("answers") ?: JSONObject()
                if (decision != "decline" && request.questions.any { answers.optString(it.id).isBlank() }) throw ApiException("Answer the sample question first.")
                val result = when {
                    request.kind == "question" -> "Sample answer saved: ${request.questions.joinToString { answers.optString(it.id) }}."
                    decision == "decline" -> "Sample test run declined."
                    else -> "Sample tests passed. No commands were run."
                }
                flow.value = current.copy(requests = current.requests.filterNot { it.id == request.id }, items = current.items + item("assistant", result))
            }
            else -> throw ApiException("Unknown sample action.")
        }
        val updated = flow.value ?: return
        updateTask(agentId) { it.copy(attention = if (updated.requests.isNotEmpty()) "needs_input" else "idle", lastLine = updated.items.last().text) }
    }

    private fun requireControl() {
        if (!state.value.canControl) throw ApiException("Pair the sample phone with code 123456 first.", 401)
    }
    private fun findTask(id: String) = agents.value.firstOrNull { it.taskId == id || it.agentId == id }
    private fun task(id: String) = findTask(id)
        ?: throw ApiException("This sample task has closed.")
    private fun updateTask(id: String, transform: (RemoteAgent) -> RemoteAgent) {
        _agents.value = agents.value.map { if (it.taskId == id || it.agentId == id) transform(it) else it }
    }
    private fun item(kind: String, text: String) = ChatItem("demo-item-${++nextId}", kind, text, null)
    private fun chat(text: String) = ChatState("idle", "Offline sample model", listOf(item("assistant", text)), emptyList(), null)
    private fun agent(id: String, name: String, isChat: Boolean, attention: String, lastLine: String) = RemoteAgent(
        agentId = id, taskId = id, taskName = name, running = true, exitCode = null,
        lastLine = lastLine, projectName = "Sample project", agentName = if (isChat) "Demo chat agent" else "Demo terminal agent",
        attention = attention, isChat = isChat,
    )
    private fun samples() = listOf(
        agent("demo-review", "Review the welcome screen", true, "needs_input", "Waiting for your approval and answer"),
        agent("demo-terminal", "Explore terminal, notes and changes", false, "idle", "12 sample tests passed").copy(ci = "success"),
        agent("demo-ci", "Fix a sample CI failure", false, "error", "Sample welcome test failed").copy(ci = "failure"),
        agent("demo-working", "Interrupt a working chat", true, "active", "Simulated work in progress"),
        agent("demo-minimized", "A minimized sample task", false, "idle", "Sample task is minimized").copy(collapsed = true),
    )

    private companion object {
        val SAMPLE_DIFF = """
            diff --git a/welcome.ts b/welcome.ts
            --- a/welcome.ts
            +++ b/welcome.ts
            @@ -1,2 +1,3 @@
            -export const greeting = 'Hello';
            +export const greeting = 'Welcome';
            +// Offline sample change
             export const accessible = true;
        """.trimIndent()
    }
}
