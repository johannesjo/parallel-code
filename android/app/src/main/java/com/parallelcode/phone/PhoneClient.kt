package com.parallelcode.phone

import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject

/** UI operations of a phone session. DemoSession implements these without any transport. */
interface PhoneClient {
    val state: StateFlow<ConnectionState>
    val agents: StateFlow<List<RemoteAgent>>
    val computers: StateFlow<List<SavedComputer>>
    val latencyMs: StateFlow<Long?>
    fun start(holder: String)
    fun stop(holder: String)
    fun link(link: ConnectionLink)
    fun switchTo(baseUrl: String)
    fun rename(baseUrl: String, alias: String?)
    fun forget(baseUrl: String? = state.value.link?.baseUrl)
    fun reconnect()
    fun onVpnPolicyChanged()
    suspend fun pair(pin: String, remember: Boolean)
    suspend fun fetchProjects(): List<MobileProject>
    suspend fun fetchAgentChoices(): List<MobileAgentChoice>
    suspend fun createTask(projectId: String, name: String, prompt: String, agentId: String? = null, model: String? = null): String
    suspend fun fetchNotes(taskId: String): String
    suspend fun saveNotes(taskId: String, notes: String)
    suspend fun fetchDiff(taskId: String): TaskDiff
    suspend fun fetchUsage(): List<ProviderUsage>
    suspend fun fetchMergeReadiness(taskId: String): MergeReadiness
    suspend fun mergeTask(taskId: String, squash: Boolean, cleanup: Boolean)
    suspend fun fetchFixCiPrompt(taskId: String): String?
    suspend fun sendFixCiPrompt(taskId: String, prompt: String)
    suspend fun closeTask(taskId: String, force: Boolean): List<String>
    fun getTerminalBuffer(agentId: String): TerminalBuffer
    fun releaseTerminal(agentId: String)
    fun setViewSize(agentId: String, cols: Int, rows: Int)
    fun releaseViewSize(agentId: String)
    fun pauseViewSize()
    fun resumeViewSize()
    fun scrollTerminal(agentId: String, lines: Int)
    suspend fun sendInput(agentId: String, data: String, submit: Boolean, prefixKey: String? = null)
    fun watchChat(agentId: String): StateFlow<ChatState?>
    fun unwatchChat(agentId: String)
    suspend fun sendChatAction(agentId: String, action: String, params: JSONObject = JSONObject())
}
