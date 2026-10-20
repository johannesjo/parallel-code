package com.parallelcode.phone

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Retains virtual terminal state and scrollback history for an agent.
 * Kept in memory while the app is connected so background tasks can buffer their
 * output and allow users to read up when selecting the task.
 */
class TerminalBuffer(
    val agentId: String,
    val screen: TerminalScreen = TerminalScreen(),
) : TerminalListener {
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version.asStateFlow()

    override fun onScrollback(data: ByteArray, cols: Int, rows: Int) {
        screen.reset(cols, rows, data)
        _version.value++
    }

    fun resize(cols: Int, rows: Int) {
        screen.resize(cols, rows)
        _version.value++
    }

    override fun onOutput(data: ByteArray) {
        screen.feed(data)
        _version.value++
    }
}
