package com.parallelcode.phone

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

enum class ConnectionStatus { CONNECTING, CONNECTED, DISCONNECTED, WAITING_FOR_VPN }

/** With "Wait for VPN" on, hold off connecting until a VPN is up, unless the phone is on the home Wi-Fi. */
fun waitsForVpn(waitForVpn: Boolean, vpnActive: Boolean, wifiSsid: String?, homeWifiSsid: String?): Boolean =
    waitForVpn && !vpnActive && (homeWifiSsid == null || wifiSsid != homeWifiSsid)

/** What the UI needs to know about the link to the desktop. */
data class ConnectionState(
    /** The linked desktop; null until a QR code is scanned. */
    val link: ConnectionLink? = null,
    val status: ConnectionStatus = ConnectionStatus.DISCONNECTED,
    /** True once the socket authenticated with the paired token, which may type. */
    val canControl: Boolean = false,
    /** Set when the desktop rejected the QR-code token; only a fresh scan recovers. */
    val linkExpired: Boolean = false,
)

interface TerminalListener {
    fun onScrollback(data: ByteArray, cols: Int, rows: Int)
    fun onOutput(data: ByteArray)
}

/** Read timeout for requests that wait on desktop git work; see [RemoteClient.slowHttp]. */
private const val SLOW_REQUEST_SECONDS = 130L

/** A REST call the desktop refused or could not answer; `status` is 0 when it was unreachable. */
/** [json] is the error reply's body, for routes that explain a refusal (e.g. close warnings). */
class ApiException(message: String, val status: Int = 0, val json: JSONObject? = null) : IOException(message)

data class MobileProject(val id: String, val name: String, val agentName: String?)

/** What another saved computer reported in the last poll, under the name the phone shows for it. */
data class ComputerSnapshot(val label: String, val agents: List<RemoteAgent>, val usage: List<ProviderUsage>)

/** One row of the desktop's merge-readiness panel, as that panel labels it. */
data class ReadinessCheck(val label: String, val status: String, val detail: String)

/**
 * The desktop's merge readiness for a task. [canMerge] is false only for a merge-safety
 * blocker, never for a warning, so a warning still leaves merging possible.
 */
data class MergeReadiness(
    val overall: String,
    val canMerge: Boolean,
    val baseBranch: String,
    val branchName: String,
    val checks: List<ReadinessCheck>,
)

/**
 * Client for the desktop's Remote Access server (electron/remote/server.ts). Mirrors the phone web
 * UI in src/remote/ws.ts: authenticate with the first WebSocket message, prefer the paired token,
 * and fall back to view-only when the desktop revokes it. All state changes on the main thread.
 */
class RemoteClient(
    private val credentials: CredentialStore,
    private val vpnActive: StateFlow<Boolean> = MutableStateFlow(true),
    private val wifiSsid: StateFlow<String?> = MutableStateFlow(null),
    private val waitForVpn: () -> Boolean = { false },
    private val homeWifiSsid: () -> String? = { null },
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    /**
     * For requests the desktop answers only once real git work is done: creating a task builds a
     * worktree; merging, closing, the diff and merge readiness run git too. The desktop waits up to 120 s for that work
     * (callRenderer in electron/ipc/register.ts), so OkHttp's default 10 s read timeout reported
     * "could not reach your computer" for a request that was still running, and usually succeeded.
     * A little longer than the desktop lets the desktop's own error come through instead.
     */
    private val slowHttp = http.newBuilder().readTimeout(SLOW_REQUEST_SECONDS, TimeUnit.SECONDS).build()

    private val _state = MutableStateFlow(ConnectionState(link = credentials.link))
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    init {
        scope.launch { combine(vpnActive, wifiSsid) { _, _ -> }.collect { onVpnPolicyChanged() } }
    }

    private val _agents = MutableStateFlow<List<RemoteAgent>>(emptyList())
    val agents: StateFlow<List<RemoteAgent>> = _agents.asStateFlow()
    private val _computers = MutableStateFlow(credentials.computers)

    /** Every desktop this phone has linked to; [ConnectionState.link] is the one in use. */
    val computers: StateFlow<List<SavedComputer>> = _computers.asStateFlow()
    private val _otherComputers = MutableStateFlow<Map<String, ComputerSnapshot>>(emptyMap())

    /**
     * The saved computers other than the one in use, by address, from those that answered the last
     * poll (see [pollOtherComputers]). Feeds the home-screen widget.
     */
    val otherComputers: StateFlow<Map<String, ComputerSnapshot>> = _otherComputers.asStateFlow()
    private var pollJob: Job? = null
    private val _latencyMs = MutableStateFlow<Long?>(null)
    val latencyMs: StateFlow<Long?> = _latencyMs.asStateFlow()

    private var socket: WebSocket? = null
    // OkHttp queues sends before the socket opens, which would put them ahead of the auth message.
    private var socketOpen = false
    private var authKind = TokenKind.MOBILE
    private var started = false
    private var reconnectJob: Job? = null
    private var handshakeJob: Job? = null
    private val terminalBuffers = mutableMapOf<String, TerminalBuffer>()
    private val subscribedAgents = mutableSetOf<String>()
    private val chats = mutableMapOf<String, MutableStateFlow<ChatState?>>()
    private val chatWatchers = mutableMapOf<String, Int>()
    /** The agent whose PTY takes this phone's terminal size, and that size (see [setViewSize]). */
    private var viewSize: Triple<String, Int, Int>? = null
    private var viewSizeSent = false
    private val terminalListeners = mutableMapOf<String, MutableSet<TerminalListener>>()
    private val pending = mutableMapOf<String, CompletableDeferred<Unit>>()
    private var nextRequestId = 0

    private enum class TokenKind { MOBILE, PAIRED }

    /** Keep a socket open while the app is in the foreground. */
    private val holders = mutableSetOf<String>()

    /**
     * Keep the connection open for [holder] (the visible app, the background notification service);
     * it closes once no holder remains.
     */
    fun start(holder: String) {
        holders.add(holder)
        started = true
        connect()
        if (pollJob == null) pollOtherComputers()
    }

    fun stop(holder: String) {
        holders.remove(holder)
        if (holders.isNotEmpty()) return
        started = false
        closeSocket()
        pollJob?.cancel()
        pollJob = null
    }

    /**
     * While a holder keeps the app connected, ask every other saved computer for its agents and usage
     * each [OTHER_COMPUTERS_POLL_MS] over plain HTTP, rather than holding a socket open to each.
     */
    private fun pollOtherComputers() {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (true) {
                val active = credentials.link?.baseUrl
                val others = credentials.computers.filter { it.baseUrl != active }
                _otherComputers.value = if (others.isEmpty() || mustWaitForVpn()) {
                    emptyMap()
                } else {
                    others.mapNotNull { c -> fetchSnapshotFrom(c)?.let { c.baseUrl to it } }.toMap()
                }
                delay(OTHER_COMPUTERS_POLL_MS)
            }
        }
    }

    /**
     * [computer]'s agents and usage, or null when it can't be reached or refuses the token. A desktop
     * that answers for agents but not usage still counts, with no usage.
     */
    private suspend fun fetchSnapshotFrom(computer: SavedComputer): ComputerSnapshot? {
        val agents = getFrom(computer, "/api/agents")?.takeIf { it.first in 200..299 }
            ?.let { parseAgentList(it.second) } ?: return null
        return ComputerSnapshot(computer.label, agents, usageFrom(computer))
    }

    private suspend fun usageFrom(computer: SavedComputer): List<ProviderUsage> {
        if (usageRoute.isMissing(computer.baseUrl)) return emptyList()
        val (code, body) = getFrom(computer, "/api/mobile/usage") ?: return emptyList()
        usageRoute.record(computer.baseUrl, code)
        if (code !in 200..299) return emptyList()
        return runCatching { parseUsage(JSONObject(body)) }.getOrDefault(emptyList())
    }

    /** The status and body of a GET to [path] on [computer], or null when it can't be reached. */
    private suspend fun getFrom(computer: SavedComputer, path: String): Pair<Int, String>? = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(computer.baseUrl + path)
            .header("Authorization", "Bearer ${computer.pairedToken ?: computer.token}")
            .build()
        try {
            http.newCall(request).execute().use { it.code to it.body.string() }
        } catch (_: IOException) {
            null
        }
    }

    fun link(link: ConnectionLink) {
        credentials.saveLink(link)
        useActiveComputer()
    }

    /** Switch to another saved computer. */
    fun switchTo(baseUrl: String) {
        if (baseUrl == credentials.link?.baseUrl) return
        credentials.select(baseUrl)
        useActiveComputer()
    }

    /** Name a saved computer; a blank name clears the one it had. */
    fun rename(baseUrl: String, alias: String?) {
        credentials.rename(baseUrl, alias)
        _computers.value = credentials.computers
        val label = credentials.computers.firstOrNull { it.baseUrl == baseUrl }?.label
        _otherComputers.update { all -> all[baseUrl]?.let { all + (baseUrl to it.copy(label = label ?: it.label)) } ?: all }
    }

    /** Forget a saved computer; forgetting the one in use leaves the phone unlinked. */
    fun forget(baseUrl: String? = credentials.link?.baseUrl) {
        if (baseUrl == null) return
        val inUse = baseUrl == credentials.link?.baseUrl
        credentials.remove(baseUrl)
        _computers.value = credentials.computers
        _otherComputers.update { it - baseUrl }
        if (!inUse) return
        closeSocket()
        resetSession()
        _state.value = ConnectionState()
    }

    /** Drop everything from the previous computer and connect to the one now selected. */
    private fun useActiveComputer() {
        closeSocket()
        resetSession()
        _computers.value = credentials.computers
        _state.value = ConnectionState(link = credentials.link)
        reconnect()
        if (started) pollOtherComputers()
    }

    private fun resetSession() {
        _agents.value = emptyList()
        _latencyMs.value = null
        _usage.value = emptyList()
        terminalBuffers.clear()
        subscribedAgents.clear()
        terminalListeners.clear()
        chats.values.forEach { it.value = null }
        viewSize = null
        viewSizeSent = false
    }

    fun reconnect() {
        // A manual reconnect is the user's way to pick up a desktop that was updated meanwhile.
        usageRoute.clear()
        closeSocket()
        if (started) connect()
    }

    /** Pauses or resumes connecting when the VPN, the Wi-Fi network, or the wait-for-VPN settings change. */
    fun onVpnPolicyChanged() {
        if (!started) return
        if (mustWaitForVpn()) {
            closeSocket()
            _state.update { it.copy(status = ConnectionStatus.WAITING_FOR_VPN, canControl = false) }
        } else if (_state.value.status == ConnectionStatus.WAITING_FOR_VPN) {
            connect()
        }
    }

    private fun mustWaitForVpn() = waitsForVpn(waitForVpn(), vpnActive.value, wifiSsid.value, homeWifiSsid())

    /** Trade the desktop's six-digit PIN for a paired token, then reconnect with it. */
    suspend fun pair(pin: String, remember: Boolean) {
        val reply = api(
            "POST",
            "/api/pair/verify",
            JSONObject().put("pin", pin).put("remember", remember),
            token = credentials.pairedToken ?: credentials.link?.token,
        )
        val token = reply.optString("token").takeIf { it.isNotEmpty() }
            ?: throw ApiException("Your computer sent an unexpected reply.")
        credentials.savePairedToken(token)
        _computers.value = credentials.computers
        reconnect()
    }

    /** Projects a paired phone may start tasks in. */
    suspend fun fetchProjects(): List<MobileProject> {
        val list = JSONArray(apiRaw("GET", "/api/mobile/projects", null, pairedTokenOrThrow()))
        return List(list.length()) { i ->
            val p = list.getJSONObject(i)
            MobileProject(p.getString("id"), p.getString("name"), p.optString("agentName").ifEmpty { null })
        }
    }

    /**
     * Agents and models a paired phone may start tasks with. Empty from a desktop that predates
     * the route: it refuses unknown paths for a paired token with 403. Tasks then use its
     * default agent.
     */
    suspend fun fetchAgentChoices(): List<MobileAgentChoice> {
        val raw = try {
            apiRaw("GET", "/api/mobile/agents", null, pairedTokenOrThrow())
        } catch (e: ApiException) {
            if (e.status == 403 || e.status == 404) return emptyList() else throw e
        }
        return try {
            parseAgentChoices(raw)
        } catch (e: JSONException) {
            throw ApiException("Your computer sent an unexpected reply.")
        }
    }

    /**
     * Start a top-level task on the desktop; returns its task id. A null [agentId]
     * or [model] leaves that choice to the desktop's defaults.
     */
    suspend fun createTask(
        projectId: String,
        name: String,
        prompt: String,
        agentId: String? = null,
        model: String? = null,
    ): String {
        val body = JSONObject().put("projectId", projectId).put("name", name).put("prompt", prompt)
        agentId?.let { body.put("agentId", it) }
        model?.let { body.put("model", it) }
        return api("POST", "/api/mobile/tasks", body, pairedTokenOrThrow(), slow = true).getString("taskId")
    }

    /** The task's notes panel; readable with the view-only token. */
    suspend fun fetchNotes(taskId: String): String =
        api("GET", notesPath(taskId), null, credentials.pairedToken ?: credentials.link?.token)
            .optString("notes")

    suspend fun saveNotes(taskId: String, notes: String) {
        api("PUT", notesPath(taskId), JSONObject().put("notes", notes), pairedTokenOrThrow())
    }

    /** The task's changes against its base branch; readable with the view-only token. */
    suspend fun fetchDiff(taskId: String): TaskDiff {
        val json = api(
            "GET",
            "/api/mobile/tasks/${encodePath(taskId)}/diff",
            null,
            credentials.pairedToken ?: credentials.link?.token,
            slow = true,
        )
        return TaskDiff.from(json)
    }

    /**
     * The desktop status bar's subscription usage; readable with the view-only token. Empty, without
     * asking again, from a desktop that has no usage route yet (it answered 404).
     */
    suspend fun fetchUsage(): List<ProviderUsage> {
        val baseUrl = credentials.link?.baseUrl
        if (baseUrl != null && usageRoute.isMissing(baseUrl)) return emptyList<ProviderUsage>().also { _usage.value = it }
        val usage = try {
            parseUsage(api("GET", "/api/mobile/usage", null, credentials.pairedToken ?: credentials.link?.token))
        } catch (e: ApiException) {
            if (baseUrl == null) throw e
            usageRoute.record(baseUrl, e.status)
            if (!usageRoute.isMissing(baseUrl)) throw e
            emptyList()
        }
        _usage.value = usage
        return usage
    }

    /**
     * The desktop's merge-readiness checks for a task, built by the same
     * `buildMergeReadiness` the desktop dialog uses. Read-only, so the view-only
     * token may read it.
     */
    suspend fun fetchMergeReadiness(taskId: String): MergeReadiness =
        parseMergeReadiness(
            api(
                "GET",
                "/api/mobile/tasks/${encodePath(taskId)}/readiness",
                null,
                credentials.pairedToken ?: credentials.link?.token,
                slow = true,
            ),
        )

    /** Merge a task into its base branch. Runs real git, so it needs the paired token. */
    suspend fun mergeTask(taskId: String, squash: Boolean, cleanup: Boolean) {
        api(
            "POST",
            "/api/mobile/tasks/${encodePath(taskId)}/merge",
            JSONObject().put("squash", squash).put("cleanup", cleanup),
            pairedTokenOrThrow(),
            slow = true,
        )
    }

    private val _usage = MutableStateFlow<List<ProviderUsage>>(emptyList())

    private val usageRoute = MissingRoutes()

    /** The last usage snapshot fetched, for the widget. */
    val usage: StateFlow<List<ProviderUsage>> = _usage.asStateFlow()

    /**
     * Close a task on the desktop: stops its agents and removes its worktree. Unless [force], the
     * desktop refuses when work would be lost and this returns its warnings; empty means closed.
     */
    suspend fun closeTask(taskId: String, force: Boolean): List<String> = try {
        api(
            "POST",
            "/api/mobile/tasks/${encodePath(taskId)}/close",
            JSONObject().put("force", force),
            pairedTokenOrThrow(),
            slow = true,
        )
        emptyList()
    } catch (e: ApiException) {
        val warnings = e.json?.optJSONArray("warnings")
        if (e.status != 409 || warnings == null || warnings.length() == 0) throw e
        List(warnings.length()) { warnings.optString(it) }
    }

    private fun notesPath(taskId: String) = "/api/mobile/notes/" + encodePath(taskId)

    private fun encodePath(segment: String) = URLEncoder.encode(segment, "UTF-8").replace("+", "%20")

    private fun pairedTokenOrThrow(): String =
        credentials.pairedToken ?: throw ApiException("Pair this phone first.", 401)

    private suspend fun api(
        method: String,
        path: String,
        body: JSONObject?,
        token: String?,
        slow: Boolean = false,
    ): JSONObject =
        try {
            JSONObject(apiRaw(method, path, body, token, slow))
        } catch (e: JSONException) {
            throw ApiException("Your computer sent an unexpected reply.")
        }

    private suspend fun apiRaw(
        method: String,
        path: String,
        body: JSONObject?,
        token: String?,
        slow: Boolean = false,
    ): String {
        val link = credentials.link ?: throw ApiException("Not connected to a computer.")
        if (token == null) throw ApiException("Not connected to a computer.")
        if (mustWaitForVpn()) {
            throw ApiException("Waiting for VPN connection. Connect your VPN and try again.")
        }
        val request = Request.Builder()
            .url(link.baseUrl + path)
            .header("Authorization", "Bearer $token")
            .method(method, body?.toString()?.toRequestBody("application/json".toMediaType()))
            .build()
        val start = System.currentTimeMillis()
        val (code, text) = withContext(Dispatchers.IO) {
            try {
                (if (slow) slowHttp else http).newCall(request).execute().use { it.code to it.body.string() }
            } catch (e: IOException) {
                _latencyMs.value = null
                // A slow request may still finish on the desktop, so don't call it unreachable.
                // (A connect timeout is also a SocketTimeoutException, hence the hedged wording.)
                if (slow && e is SocketTimeoutException) {
                    throw ApiException("Your computer did not answer in time.")
                }
                throw ApiException("Could not reach your computer. Check you're on the same network.")
            }
        }
        val elapsed = System.currentTimeMillis() - start
        _latencyMs.value = elapsed
        if (code in 200..299) return text
        val json = runCatching { JSONObject(text) }.getOrNull()
        val error = json?.optString("error")?.takeIf { it.isNotEmpty() }
        // 401 means the desktop no longer knows this token, so drop to view-only like a 4001 close.
        // 403 only means this route is not open to the token (or to an older desktop), so the
        // pairing stays.
        if (code == 401 && token == credentials.pairedToken && path != "/api/pair/verify") {
            credentials.clearPairedToken()
            _computers.value = credentials.computers
            reconnect()
            throw ApiException("This phone is no longer paired. Pair again to continue.", code)
        }
        throw ApiException(error ?: "Request failed ($code).", code, json)
    }

    /**
     * Stream an agent's terminal while it is on screen. Only viewed terminals stream: opening one
     * starts from the desktop's rendered snapshot, so nothing needs buffering in the background.
     * Pair with [releaseTerminal].
     */
    fun getTerminalBuffer(agentId: String): TerminalBuffer {
        val buffer = terminalBuffers.getOrPut(agentId) { TerminalBuffer(agentId) }
        subscribeAgent(agentId)
        return buffer
    }

    /** Stop streaming a terminal that left the screen. */
    fun releaseTerminal(agentId: String) {
        terminalBuffers.remove(agentId)
        if (subscribedAgents.remove(agentId) && socketOpen) {
            send(JSONObject().put("type", "unsubscribe").put("agentId", agentId))
        }
    }

    private fun subscribeAgent(agentId: String) {
        if (subscribedAgents.add(agentId) && socketOpen) {
            send(JSONObject().put("type", "subscribe").put("agentId", agentId))
        }
    }

    /**
     * Size an agent's PTY to this phone's terminal view, so full-screen TUIs such as Claude Code fill
     * the phone. Needs pairing. The desktop gets its size back on [releaseViewSize] or disconnect.
     */
    fun setViewSize(agentId: String, cols: Int, rows: Int) {
        viewSize?.let { if (it.first != agentId) releaseViewSize(it.first) }
        if (viewSize == Triple(agentId, cols, rows)) return
        viewSize = Triple(agentId, cols, rows)
        viewSizeSent = false
        sendViewSize()
    }

    fun releaseViewSize(agentId: String) {
        if (viewSize?.first != agentId) return
        viewSize = null
        if (!socketOpen) return
        send(JSONObject().put("type", "view-size").put("agentId", agentId))
        // Resubscribe for a fresh snapshot, which carries the desktop's size again.
        if (agentId in subscribedAgents) {
            send(JSONObject().put("type", "unsubscribe").put("agentId", agentId))
            send(JSONObject().put("type", "subscribe").put("agentId", agentId))
        }
    }

    /**
     * The app left the screen but the socket stays open for notifications: give the desktop its
     * size back until [resumeViewSize].
     */
    fun pauseViewSize() {
        val agentId = viewSize?.first ?: return
        if (socketOpen && viewSizeSent) send(JSONObject().put("type", "view-size").put("agentId", agentId))
        viewSizeSent = false
    }

    fun resumeViewSize() = sendViewSize()

    /** Only paired sockets may size a PTY; the server closes a view-only one that tries. */
    private fun sendViewSize() {
        val (agentId, cols, rows) = viewSize ?: return
        if (viewSizeSent || !socketOpen || !_state.value.canControl) return
        send(JSONObject().put("type", "view-size").put("agentId", agentId).put("cols", cols).put("rows", rows))
        viewSizeSent = true
        terminalBuffers[agentId]?.resize(cols, rows)
    }

    /** Stream an agent's terminal. Retained for backwards compatibility. */
    fun watchTerminal(agentId: String, listener: TerminalListener): () -> Unit {
        getTerminalBuffer(agentId)
        val listeners = terminalListeners.getOrPut(agentId) { mutableSetOf() }
        listeners.add(listener)
        return {
            listeners.remove(listener)
            if (listeners.isEmpty()) {
                terminalListeners.remove(agentId)
            }
        }
    }

    /**
     * Types [data] into the agent's terminal; `submit` presses Enter once the text has landed.
     *
     * A [prefixKey] (such as `!` for an agent's shell mode) is typed first, in a write of its own,
     * so the TUI reads it as a keystroke and opens that mode. The phone types it itself rather
     * than sending the protocol's `prefixKey`: desktops from before that field drop it, which
     * would send a shell command to the agent as a prompt.
     */
    suspend fun sendInput(agentId: String, data: String, submit: Boolean, prefixKey: String? = null) {
        if (data.length > MAX_INPUT_LENGTH) {
            throw IOException("This message is too long. Shorten it and try again.")
        }
        if (prefixKey != null) {
            request(JSONObject().put("type", "input").put("agentId", agentId).put("data", prefixKey).put("submit", false))
            // The prefix needs its own terminal read before the text arrives, as on the desktop.
            delay(PREFIX_KEY_DELAY_MS)
        }
        request(
            JSONObject()
                .put("type", "input")
                .put("agentId", agentId)
                .put("data", data)
                .put("submit", submit),
        )
    }

    /**
     * Follow a built-in chat's conversation, as the phone web UI does. Call [unwatchChat] when done;
     * the state stays null until the desktop sends the first frame.
     */
    fun watchChat(agentId: String): StateFlow<ChatState?> {
        val flow = chats.getOrPut(agentId) { MutableStateFlow(null) }
        val watchers = chatWatchers[agentId] ?: 0
        chatWatchers[agentId] = watchers + 1
        if (watchers == 0 && socketOpen) send(JSONObject().put("type", "chat-subscribe").put("agentId", agentId))
        return flow.asStateFlow()
    }

    fun unwatchChat(agentId: String) {
        val watchers = (chatWatchers[agentId] ?: return) - 1
        if (watchers > 0) {
            chatWatchers[agentId] = watchers
            return
        }
        chatWatchers.remove(agentId)
        chats.remove(agentId)
        if (socketOpen) send(JSONObject().put("type", "chat-unsubscribe").put("agentId", agentId))
    }

    /** One of the desktop's chat actions (send, interrupt, respond, …); needs pairing. */
    suspend fun sendChatAction(agentId: String, action: String, params: JSONObject = JSONObject()) {
        if (params.toString().toByteArray().size > MAX_CHAT_MESSAGE_LENGTH) {
            throw IOException("This message is too long to send from a phone.")
        }
        request(
            JSONObject()
                .put("type", "chat-action")
                .put("agentId", agentId)
                .put("action", action)
                .put("params", params),
        )
    }

    /** Send a message the server confirms with an input-result for its requestId. */
    private suspend fun request(msg: JSONObject) {
        val ws = socket
        if (!_state.value.canControl || ws == null) {
            throw IOException("Reconnect before sending. Your draft has been kept.")
        }
        val requestId = (++nextRequestId).toString()
        val result = CompletableDeferred<Unit>()
        pending[requestId] = result
        msg.put("requestId", requestId)
        if (!ws.send(msg.toString())) {
            pending.remove(requestId)
            throw IOException("Could not send. Your draft has been kept.")
        }
        try {
            withTimeout(REQUEST_TIMEOUT_MS) { result.await() }
        } catch (e: TimeoutCancellationException) {
            throw IOException(
                "Delivery could not be confirmed. Check the output before retrying; your draft has been kept.",
            )
        } finally {
            pending.remove(requestId)
        }
    }

    private fun connect() {
        if (socket != null) return
        val link = credentials.link ?: return
        if (mustWaitForVpn()) {
            reconnectJob?.cancel()
            _state.update { it.copy(status = ConnectionStatus.WAITING_FOR_VPN, canControl = false, linkExpired = false) }
            return
        }
        val paired = credentials.pairedToken
        authKind = if (paired != null) TokenKind.PAIRED else TokenKind.MOBILE
        val token = paired ?: link.token

        reconnectJob?.cancel()
        _state.update { it.copy(status = ConnectionStatus.CONNECTING, canControl = false, linkExpired = false) }
        val request = Request.Builder().url(link.webSocketUrl).build()
        lateinit var ws: WebSocket
        ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Authenticate in the first message, not the URL, so the token stays out of logs.
                webSocket.send(JSONObject().put("type", "auth").put("token", token).toString())
                scope.launch {
                    if (socket !== ws) return@launch
                    socketOpen = true
                    viewSizeSent = false
                    subscribedAgents.forEach {
                        send(JSONObject().put("type", "subscribe").put("agentId", it))
                    }
                    chatWatchers.keys.forEach {
                        send(JSONObject().put("type", "chat-subscribe").put("agentId", it))
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = parseServerMessage(text) ?: return
                scope.launch { if (socket === ws) handle(msg) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                scope.launch { if (socket === ws) onDisconnect(code) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scope.launch { if (socket === ws) onDisconnect(CLOSE_ABNORMAL) }
            }
        })
        socket = ws
        // A sleeping phone or unreachable computer may never finish the handshake.
        handshakeJob = scope.launch {
            delay(HANDSHAKE_TIMEOUT_MS)
            if (socket === ws && _state.value.status != ConnectionStatus.CONNECTED) {
                onDisconnect(CLOSE_ABNORMAL)
            }
        }
    }

    private fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.Agents -> {
                handshakeJob?.cancel()
                _state.update {
                    it.copy(status = ConnectionStatus.CONNECTED, canControl = authKind == TokenKind.PAIRED)
                }
                _agents.value = msg.list
                sendViewSize()

                // Clean up deleted agents that no longer exist on the desktop
                val activeIds = msg.list.map { it.agentId }.toSet()
                val deleted = subscribedAgents.filter { it !in activeIds }
                deleted.forEach { id ->
                    subscribedAgents.remove(id)
                    terminalBuffers.remove(id)
                    terminalListeners.remove(id)
                    if (socketOpen) {
                        send(JSONObject().put("type", "unsubscribe").put("agentId", id))
                    }
                }
            }
            is ServerMessage.Status -> {
                _agents.update { list ->
                    list.map { if (it.agentId == msg.agentId) it.copy(running = msg.running, exitCode = msg.exitCode) else it }
                }
                if (msg.running) {
                    getTerminalBuffer(msg.agentId)
                }
            }
            is ServerMessage.Scrollback -> {
                val buffer = terminalBuffers.getOrPut(msg.agentId) { TerminalBuffer(msg.agentId) }
                buffer.onScrollback(msg.data, msg.cols, msg.rows)
                // A snapshot sent before the server applied this phone's size carries the desktop's.
                viewSize?.let { (agentId, cols, rows) -> if (agentId == msg.agentId && viewSizeSent) buffer.resize(cols, rows) }
                terminalListeners[msg.agentId]?.toList()?.forEach { it.onScrollback(msg.data, msg.cols, msg.rows) }
            }
            is ServerMessage.Output -> {
                terminalBuffers[msg.agentId]?.onOutput(msg.data)
                terminalListeners[msg.agentId]?.toList()?.forEach { it.onOutput(msg.data) }
            }
            is ServerMessage.Chat -> chats[msg.agentId]?.value = msg.state
            is ServerMessage.InputResult -> {
                val result = pending.remove(msg.requestId) ?: return
                if (msg.ok) {
                    result.complete(Unit)
                } else {
                    result.completeExceptionally(IOException(msg.error ?: "Could not send. Your draft has been kept."))
                }
            }
        }
    }

    private fun onDisconnect(code: Int) {
        closeSocket()
        // 4001: the desktop rejected the token. A stale paired token falls back to view-only; a
        // stale QR-code token needs a fresh scan. 4003: this phone lost its typing rights.
        when {
            code == CLOSE_UNAUTHORIZED && authKind == TokenKind.MOBILE -> {
                credentials.clear()
                _computers.value = credentials.computers
                _agents.value = emptyList()
                _state.value = ConnectionState(linkExpired = true)
                return
            }
            code == CLOSE_UNAUTHORIZED || code == CLOSE_FORBIDDEN -> {
                credentials.clearPairedToken()
                _computers.value = credentials.computers
                if (code == CLOSE_UNAUTHORIZED) {
                    if (started) connect()
                    return
                }
            }
        }
        if (!started) return
        if (mustWaitForVpn()) {
            _state.update { it.copy(status = ConnectionStatus.WAITING_FOR_VPN, canControl = false) }
            return
        }
        reconnectJob = scope.launch {
            delay(RECONNECT_DELAY_MS)
            connect()
        }
    }

    private fun closeSocket() {
        handshakeJob?.cancel()
        reconnectJob?.cancel()
        socketOpen = false
        socket?.let {
            socket = null
            it.close(CLOSE_NORMAL, null)
        }
        _state.update { it.copy(status = ConnectionStatus.DISCONNECTED, canControl = false) }
        _latencyMs.value = null
        val interrupted = IOException(
            "Connection interrupted. Your message may have reached the terminal. Check the output before retrying.",
        )
        pending.values.forEach { it.completeExceptionally(interrupted) }
        pending.clear()
    }

    private fun send(msg: JSONObject) {
        if (socketOpen) socket?.send(msg.toString())
    }

    private companion object {
        const val CLOSE_NORMAL = 1000
        const val CLOSE_ABNORMAL = 1006
        const val CLOSE_UNAUTHORIZED = 4001
        const val CLOSE_FORBIDDEN = 4003
        const val HANDSHAKE_TIMEOUT_MS = 10_000L
        const val RECONNECT_DELAY_MS = 3_000L
        const val REQUEST_TIMEOUT_MS = 10_000L
        const val OTHER_COMPUTERS_POLL_MS = 60_000L

        // The server drops a socket message past 64 KiB; leave room for the envelope.
        const val MAX_CHAT_MESSAGE_LENGTH = 60_000
        const val MAX_INPUT_LENGTH = 4096
        const val PREFIX_KEY_DELAY_MS = 50L
    }
}
