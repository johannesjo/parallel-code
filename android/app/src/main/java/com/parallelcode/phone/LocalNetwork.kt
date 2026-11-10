package com.parallelcode.phone

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.net.URI

// Android 17 blocks apps targeting it from addresses on the phone's own Wi-Fi until the user grants
// a runtime permission from the Nearby devices group. A blocked connection reports no error: it
// times out, so the app would say "Reaching your computer…" for ever.

const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

private const val ANDROID_17 = 37

/** Older Android versions grant local network access with the INTERNET permission. */
fun localNetworkPermissionMissing(sdkInt: Int, granted: Boolean): Boolean = sdkInt >= ANDROID_17 && !granted

fun lacksLocalNetworkPermission(context: Context): Boolean = localNetworkPermissionMissing(
    Build.VERSION.SDK_INT,
    ContextCompat.checkSelfPermission(context, LOCAL_NETWORK_PERMISSION) == PackageManager.PERMISSION_GRANTED,
)

/**
 * Whether [baseUrl] points into the phone's own network: a private or link-local address, or a
 * name only that network resolves. Tailscale addresses and public host names are not, so linking
 * through them never asks for the permission.
 */
fun isLocalNetworkAddress(baseUrl: String): Boolean {
    val host = runCatching { URI(baseUrl).host }.getOrNull()?.lowercase()?.removeSurrounding("[", "]")
    if (host.isNullOrEmpty()) return false
    val octets = host.split('.').map { it.toIntOrNull() }
    if (octets.size == 4 && octets.all { it != null && it in 0..255 }) {
        val a = octets[0] ?: return false
        val b = octets[1] ?: return false
        return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
    }
    if (':' in host) {
        // Tailscale hands out addresses from its own slice of the private IPv6 range.
        if (host.startsWith("fd7a:115c:a1e0:")) return false
        return host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")
    }
    return host.endsWith(".local") || '.' !in host
}
