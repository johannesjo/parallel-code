package com.parallelcode.phone

import org.json.JSONObject

/** One changed file in a unified diff, as the desktop's diff view lists it. */
data class DiffFile(val path: String, val added: Int, val removed: Int, val lines: List<String>, val binary: Boolean)

/**
 * The desktop's answer to a diff request. `unsupported` marks a task that edits
 * the project folder in place, so it has no branch of its own to compare.
 */
data class TaskDiff(val diff: String, val truncated: Boolean, val unsupported: Boolean) {
    companion object {
        fun from(json: JSONObject) = TaskDiff(
            diff = json.optString("diff"),
            truncated = json.optBoolean("truncated"),
            unsupported = json.optBoolean("unsupported"),
        )
    }
}

/** Split `git diff` output into files; hunk lines keep their ' ', '+', '-' or '@@' prefix. */
fun parseUnifiedDiff(diff: String): List<DiffFile> {
    val files = mutableListOf<DiffFile>()
    var path: String? = null
    var lines = mutableListOf<String>()
    var added = 0
    var removed = 0
    var binary = false
    var inHunk = false

    fun finish() {
        path?.let { files.add(DiffFile(it, added, removed, lines, binary)) }
        lines = mutableListOf()
        added = 0
        removed = 0
        binary = false
        inHunk = false
    }

    for (line in diff.lineSequence()) {
        when {
            line.startsWith("diff --git ") -> {
                finish()
                // "diff --git a/old b/new": the new path, which +++ may refine below.
                path = line.substringAfter(" b/", line.removePrefix("diff --git "))
            }
            !inHunk && line.startsWith("+++ ") -> {
                val target = line.removePrefix("+++ ")
                if (target != "/dev/null") path = target.removePrefix("b/")
            }
            !inHunk && line.startsWith("--- ") -> {
                val source = line.removePrefix("--- ")
                if (path == null && source != "/dev/null") path = source.removePrefix("a/")
            }
            line.startsWith("Binary files ") -> binary = true
            line.startsWith("@@") -> {
                inHunk = true
                lines.add(line)
            }
            inHunk && line.startsWith("+") -> {
                added++
                lines.add(line)
            }
            inHunk && line.startsWith("-") -> {
                removed++
                lines.add(line)
            }
            inHunk && (line.startsWith(" ") || line.startsWith("\\")) -> lines.add(line)
        }
    }
    finish()
    return files
}
