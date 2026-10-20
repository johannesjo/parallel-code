package com.parallelcode.phone

import android.content.Context
import android.os.Build
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONException
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Tells a phone that installed the APK by hand about newer releases; nothing else would. The only
 * request is to GitHub's public releases list, at most once a day and never for store installs,
 * whose store updates them. Kept per phone, outside backups.
 */
class AppUpdates(private val context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()

    /** The installed version, e.g. "0.2.0". */
    val currentVersion: String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "0"

    /** True when an app store installed this copy and keeps it current. */
    val storeManaged: Boolean = installerPackage() in STORE_INSTALLERS

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, true)
        set(value) = prefs.edit { putBoolean(KEY_ENABLED, value) }

    private val _dismissedVersion = MutableStateFlow(prefs.getString(KEY_DISMISSED, null))

    /** The release the user put off with "Later"; the banner stays hidden until a newer one. */
    val dismissedVersion: StateFlow<String?> = _dismissedVersion.asStateFlow()

    fun dismiss(release: AppRelease) {
        prefs.edit { putString(KEY_DISMISSED, release.version) }
        _dismissedVersion.value = release.version
    }

    /** When GitHub was last asked, in epoch millis; 0 for never. */
    val checkedAt: Long get() = prefs.getLong(KEY_CHECKED_AT, 0)

    private val _available = MutableStateFlow(stored())

    /** A release newer than this install, or null. Survives restarts, so it shows before the next check. */
    val available: StateFlow<AppRelease?> = _available.asStateFlow()

    /** Check in the background when a day has passed since the last one. */
    fun checkIfDue() {
        if (!enabled || storeManaged || System.currentTimeMillis() - checkedAt < CHECK_INTERVAL_MS) return
        scope.launch {
            try {
                check()
            } catch (_: IOException) {
                // Offline or GitHub unreachable: stay quiet, checkedAt is unchanged so a later start retries.
            }
        }
    }

    /** Ask GitHub now. Returns the newer release, if any; throws [IOException] when GitHub can't be read. */
    suspend fun check(): AppRelease? {
        val newest = withContext(Dispatchers.IO) { fetchNewest() }
        prefs.edit {
            putLong(KEY_CHECKED_AT, System.currentTimeMillis())
            if (newest == null) {
                remove(KEY_VERSION)
                remove(KEY_URL)
            } else {
                putString(KEY_VERSION, newest.version)
                putString(KEY_URL, newest.downloadUrl)
            }
        }
        return stored().also { _available.value = it }
    }

    private fun fetchNewest(): AppRelease? {
        val request = Request.Builder()
            .url(RELEASES_URL)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "ParallelCodePhone/$currentVersion")
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("GitHub answered ${response.code}")
            return try {
                AppReleases.newest(JSONArray(response.body.string()))
            } catch (e: JSONException) {
                throw IOException("GitHub sent an unexpected reply", e)
            }
        }
    }

    private fun stored(): AppRelease? {
        val version = prefs.getString(KEY_VERSION, null) ?: return null
        val url = prefs.getString(KEY_URL, null) ?: return null
        // After the user installs it, the remembered release is no longer newer.
        return AppRelease(version, url).takeIf { AppReleases.isNewer(version, currentVersion) }
    }

    private fun installerPackage(): String? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getInstallerPackageName(context.packageName)
        }
    }.getOrNull()

    companion object {
        private const val PREFS_NAME = "appUpdates"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_DISMISSED = "dismissedVersion"
        private const val KEY_CHECKED_AT = "checkedAt"
        private const val KEY_VERSION = "latestVersion"
        private const val KEY_URL = "latestUrl"
        private const val CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000L
        private const val RELEASES_URL = "https://api.github.com/repos/johannesjo/parallel-code/releases?per_page=100"
        private val STORE_INSTALLERS = setOf("com.android.vending", "org.fdroid.fdroid", "com.aurora.store")

        /** Where to send people who need the install steps. */
        const val INSTALL_GUIDE_URL = "https://github.com/johannesjo/parallel-code#android-app"
    }
}
