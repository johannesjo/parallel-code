package com.parallelcode.phone

import org.json.JSONObject

/** The longest prompt the desktop's Fix CI route accepts. */
internal const val MAX_FIX_CI_PROMPT_LENGTH = 60_000

/** The prompt from the desktop's Fix CI route; null (or blank) means no failed checks were found. */
internal fun parseFixCiPrompt(json: JSONObject): String? =
    if (json.isNull("prompt")) null else json.optString("prompt").takeIf { it.isNotBlank() }
