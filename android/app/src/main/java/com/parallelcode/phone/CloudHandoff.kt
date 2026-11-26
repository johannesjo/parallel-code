package com.parallelcode.phone

import org.json.JSONObject

/** The longest prompt the desktop's cloud route accepts: it becomes one command-line argument. */
internal const val MAX_CLOUD_PROMPT_LENGTH = 8_000

/**
 * Whether a task can continue in a claude.ai cloud session. When it can, [prompt] is the
 * desktop's default and [canPush] says whether its branch can be pushed first; otherwise
 * [reason] says why not.
 */
data class CloudHandoff(
    val available: Boolean,
    val prompt: String = "",
    val branchName: String = "",
    val canPush: Boolean = false,
    val reason: String = "",
)

/** The desktop's cloud route answer; anything unrecognised reads as unavailable. */
internal fun parseCloudHandoff(json: JSONObject): CloudHandoff =
    if (json.optBoolean("available", false)) {
        CloudHandoff(
            available = true,
            prompt = json.optString("prompt").take(MAX_CLOUD_PROMPT_LENGTH),
            branchName = json.optString("branchName"),
            canPush = json.optBoolean("canPush", false),
        )
    } else {
        CloudHandoff(
            available = false,
            reason = json.optString("reason").ifBlank { "This task cannot continue in the cloud." },
        )
    }
