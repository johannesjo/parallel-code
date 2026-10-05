package com.parallelcode.phone

import org.json.JSONArray
import org.json.JSONObject

/** One uncommitted file in the commit dialog; [staged] when the index holds a change to it. */
data class CommitFile(val path: String, val status: String, val staged: Boolean)

/**
 * A task's uncommitted files, as the desktop's commit dialog lists them. [unsupported] marks a
 * task without a worktree of its own, which the desktop does not commit from.
 */
data class CommitStatus(val files: List<CommitFile>, val unsupported: Boolean) {
    val stagedCount: Int get() = files.count { it.staged }
    val unstagedCount: Int get() = files.size - stagedCount
}

/** Parsing for the desktop's commit reply (GET or POST /api/mobile/tasks/:taskId/commit). */
internal fun parseCommitStatus(json: JSONObject): CommitStatus {
    val files = json.optJSONArray("files") ?: JSONArray()
    return CommitStatus(
        files = List(files.length()) { i ->
            val file = files.getJSONObject(i)
            CommitFile(
                path = file.optString("path"),
                status = file.optString("status"),
                staged = file.optBoolean("staged", false),
            )
        },
        unsupported = json.optBoolean("unsupported", false),
    )
}
