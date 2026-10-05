package com.parallelcode.phone

import org.json.JSONObject

/** Parsing for the desktop's merge-readiness reply (GET /api/mobile/tasks/:taskId/readiness). */
internal fun parseMergeReadiness(json: JSONObject): MergeReadiness {
    val readiness = json.getJSONObject("readiness")
    val checks = readiness.getJSONArray("checks")
    return MergeReadiness(
        overall = readiness.optString("overall", "checking"),
        // Default to refusing: an unreadable verdict must not enable a git write.
        canMerge = json.optBoolean("canMerge", false),
        baseBranch = json.optString("baseBranch", "main"),
        branchName = json.optString("branchName", ""),
        checks = List(checks.length()) { i ->
            val check = checks.getJSONObject(i)
            ReadinessCheck(
                label = check.optString("label"),
                status = check.optString("status", "neutral"),
                detail = check.optString("detail"),
            )
        },
    )
}
