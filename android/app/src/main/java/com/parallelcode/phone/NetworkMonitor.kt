package com.parallelcode.phone

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Monitors whether an active VPN connection (such as Tailscale, WireGuard, or OpenVPN) is up on the
 * device, and the name of the Wi-Fi network it is on.
 *
 * Detects both full-tunnel VPNs (where [ConnectivityManager.getActiveNetwork] reports
 * [NetworkCapabilities.TRANSPORT_VPN]) and split-tunnel VPNs (such as Tailscale or WireGuard where
 * a separate VPN network interface is registered alongside Wi-Fi or cellular).
 *
 * Android only reveals the Wi-Fi name to apps holding location permission; without it [wifiSsid]
 * stays null. After the permission is granted, call [refreshWifi].
 */
class NetworkMonitor(context: Context) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private val _isVpnActive = MutableStateFlow(checkVpnActive())
    private val _wifiSsid = MutableStateFlow<String?>(null)

    /** Live flow indicating whether a VPN transport is currently active. */
    val isVpnActive: StateFlow<Boolean> = _isVpnActive.asStateFlow()

    /** The connected Wi-Fi network's name, or null when off Wi-Fi or the name is hidden from the app. */
    val wifiSsid: StateFlow<String?> = _wifiSsid.asStateFlow()

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            _isVpnActive.value = checkVpnActive()
        }

        override fun onLost(network: Network) {
            _isVpnActive.value = checkVpnActive()
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            _isVpnActive.value = checkVpnActive()
        }
    }

    private var wifiCallback: ConnectivityManager.NetworkCallback? = null

    private var registered = false

    /** Register network callback to observe VPN state changes. Safe to call multiple times. */
    fun start() {
        if (registered) return
        val manager = cm ?: return
        try {
            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_VPN)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                .build()
            manager.registerNetworkCallback(request, networkCallback)
            registered = true
        } catch (_: Exception) {
            // Fails gracefully in test environments or restricted execution contexts
        }
        _isVpnActive.value = checkVpnActive()
        refreshWifi()
    }

    /** Unregister network callback when monitoring is no longer needed. */
    fun stop() {
        unregisterWifi()
        if (!registered) return
        try {
            cm?.unregisterNetworkCallback(networkCallback)
        } catch (_: IllegalArgumentException) {
            // Android already dropped the callback (e.g. after a restricted-context failure); nothing to undo.
        }
        registered = false
    }

    /**
     * Re-reads the Wi-Fi name. Registering anew makes Android deliver the current network at once,
     * now with its name if location permission was just granted.
     */
    fun refreshWifi() {
        val manager = cm ?: return
        unregisterWifi()
        val callback = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            object : ConnectivityManager.NetworkCallback(FLAG_INCLUDE_LOCATION_INFO) {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    _wifiSsid.value = normalizeSsid((caps.transportInfo as? WifiInfo)?.ssid)
                }

                override fun onLost(network: Network) {
                    _wifiSsid.value = null
                }
            }
        } else {
            object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    @Suppress("DEPRECATION")
                    _wifiSsid.value = normalizeSsid(wifiManager?.connectionInfo?.ssid)
                }

                override fun onLost(network: Network) {
                    _wifiSsid.value = null
                }
            }
        }
        try {
            val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
            manager.registerNetworkCallback(request, callback)
            wifiCallback = callback
        } catch (_: Exception) {
            // Fails gracefully in test environments or restricted execution contexts
        }
    }

    private fun unregisterWifi() {
        val callback = wifiCallback ?: return
        try {
            cm?.unregisterNetworkCallback(callback)
        } catch (_: IllegalArgumentException) {
            // Android already dropped the callback (e.g. after a restricted-context failure); nothing to undo.
        }
        wifiCallback = null
    }

    /**
     * Checks if any currently active network interface provides [NetworkCapabilities.TRANSPORT_VPN].
     */
    fun checkVpnActive(): Boolean {
        val manager = cm ?: return false
        return try {
            val active = manager.activeNetwork
            if (active != null) {
                val caps = manager.getNetworkCapabilities(active)
                if (caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true) {
                    return true
                }
            }
            @Suppress("DEPRECATION")
            manager.allNetworks.any { net ->
                manager.getNetworkCapabilities(net)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
            }
        } catch (_: Exception) {
            false
        }
    }

    companion object {
        /** Android quotes UTF-8 names and reports a hidden name as "<unknown ssid>". */
        fun normalizeSsid(raw: String?): String? {
            if (raw == null || raw == WifiManager.UNKNOWN_SSID) return null
            return raw.removeSurrounding("\"").ifEmpty { null }
        }
    }
}
