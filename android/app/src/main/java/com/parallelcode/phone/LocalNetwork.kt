package com.parallelcode.phone

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Android 17 blocks apps targeting it from addresses on the phone's own Wi-Fi until the user grants
 * this runtime permission (shown as "Nearby devices"). A blocked connection reports no error: it
 * times out, so the app would say "Reaching your computer…" for ever. A VPN such as Tailscale and
 * mobile data are not affected.
 */
const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

private const val ANDROID_17 = 37

/** Older Android versions grant local network access with the INTERNET permission. */
fun localNetworkBlocked(sdkInt: Int, granted: Boolean): Boolean = sdkInt >= ANDROID_17 && !granted

fun lacksLocalNetworkAccess(context: Context): Boolean = localNetworkBlocked(
    Build.VERSION.SDK_INT,
    ContextCompat.checkSelfPermission(context, LOCAL_NETWORK_PERMISSION) == PackageManager.PERMISSION_GRANTED,
)
