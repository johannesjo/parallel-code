package com.parallelcode.phone

import org.json.JSONArray

/** A published Android release: its version and the APK to download. */
data class AppRelease(val version: String, val downloadUrl: String)

/**
 * Reads the repository's GitHub releases, which the desktop's releases share: only the ones tagged
 * `android-v*` belong to the phone app.
 */
object AppReleases {
    private const val TAG_PREFIX = "android-v"

    /**
     * The newest Android release in a GitHub releases listing, or null when it has none. Drafts,
     * prereleases, and releases without an APK yet (the build attaches it after tagging) are skipped.
     */
    fun newest(releases: JSONArray): AppRelease? = (0 until releases.length())
        .map { releases.getJSONObject(it) }
        .filter { !it.optBoolean("draft") && !it.optBoolean("prerelease") }
        .mapNotNull { release ->
            val version = release.optString("tag_name").removePrefix(TAG_PREFIX)
                .takeIf { release.optString("tag_name").startsWith(TAG_PREFIX) && parse(it) != null }
                ?: return@mapNotNull null
            val assets = release.optJSONArray("assets") ?: return@mapNotNull null
            val apk = (0 until assets.length()).map { assets.getJSONObject(it) }
                .firstOrNull { it.optString("name").endsWith(".apk") }
                ?.optString("browser_download_url")?.takeIf { it.startsWith("https://") }
                ?: return@mapNotNull null
            AppRelease(version, apk)
        }
        .maxWithOrNull { a, b -> compare(a.version, b.version) }

    /** Whether [candidate] is a later version than [current]; a version that doesn't parse never is. */
    fun isNewer(candidate: String, current: String): Boolean {
        if (parse(candidate) == null || parse(current) == null) return false
        return compare(candidate, current) > 0
    }

    /** "0.2.10" as [0, 2, 10]; null for anything but dot-separated numbers. */
    private fun parse(version: String): List<Int>? =
        version.split('.').map { it.toIntOrNull()?.takeIf { n -> n >= 0 } ?: return null }

    private fun compare(a: String, b: String): Int {
        val x = parse(a).orEmpty()
        val y = parse(b).orEmpty()
        for (i in 0 until maxOf(x.size, y.size)) {
            val diff = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
            if (diff != 0) return diff
        }
        return 0
    }
}
