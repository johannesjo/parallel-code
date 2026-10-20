package com.parallelcode.phone

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppReleasesTest {
    private fun release(
        tag: String,
        apk: String? = "parallel-code-phone.apk",
        draft: Boolean = false,
        prerelease: Boolean = false,
    ) = JSONObject()
        .put("tag_name", tag)
        .put("draft", draft)
        .put("prerelease", prerelease)
        .put(
            "assets",
            JSONArray().apply {
                if (apk != null) put(JSONObject().put("name", apk).put("browser_download_url", "https://example.test/$tag/$apk"))
            },
        )

    @Test
    fun picksTheHighestAndroidReleaseAmongDesktopOnes() {
        val newest = AppReleases.newest(
            JSONArray()
                .put(release("v9.0.0", apk = null))
                .put(release("android-v0.2.9"))
                .put(release("android-v0.2.10"))
                .put(release("android-v0.1.0")),
        )
        assertEquals(AppRelease("0.2.10", "https://example.test/android-v0.2.10/parallel-code-phone.apk"), newest)
    }

    @Test
    fun skipsDraftsPrereleasesAndReleasesWithoutAnApk() {
        val newest = AppReleases.newest(
            JSONArray()
                .put(release("android-v0.3.0", draft = true))
                .put(release("android-v0.4.0", prerelease = true))
                .put(release("android-v0.5.0", apk = null))
                .put(release("android-v0.5.1", apk = "checksums.txt"))
                .put(release("android-vnext"))
                .put(release("android-v0.2.0")),
        )
        assertEquals("0.2.0", newest?.version)
    }

    @Test
    fun hasNothingWithoutAndroidReleases() {
        assertNull(AppReleases.newest(JSONArray().put(release("v1.0.0"))))
        assertNull(AppReleases.newest(JSONArray()))
    }

    @Test
    fun comparesVersionsNumerically() {
        assertTrue(AppReleases.isNewer("0.2.10", "0.2.9"))
        assertTrue(AppReleases.isNewer("1.0", "0.9.9"))
        assertFalse(AppReleases.isNewer("0.2.0", "0.2"))
        assertFalse(AppReleases.isNewer("0.2.0", "0.2.0"))
        assertFalse(AppReleases.isNewer("0.1.9", "0.2.0"))
    }

    @Test
    fun neverOffersAVersionThatDoesNotParse() {
        assertFalse(AppReleases.isNewer("1.0-beta", "0.1.0"))
        // A build with an unusual version name is never told to update.
        assertFalse(AppReleases.isNewer("1.0.0", "dev"))
    }
}
