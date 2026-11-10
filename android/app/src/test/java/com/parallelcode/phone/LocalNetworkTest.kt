package com.parallelcode.phone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalNetworkTest {

    @Test
    fun missingOnAndroid17UntilGranted() {
        assertTrue(localNetworkPermissionMissing(sdkInt = 37, granted = false))
        assertFalse(localNetworkPermissionMissing(sdkInt = 37, granted = true))
    }

    @Test
    fun olderAndroidNeedsNoGrant() {
        assertFalse(localNetworkPermissionMissing(sdkInt = 36, granted = false))
    }

    @Test
    fun privateAndLinkLocalAddressesAreLocal() {
        listOf(
            "http://192.168.1.20:7777",
            "http://10.0.0.5:7777",
            "http://172.16.4.2:7777",
            "http://172.31.255.1:7777",
            "http://169.254.10.1:7777",
            "http://[fe80::1]:7777",
            "http://[fd12:3456::1]:7777",
            "http://desk.local:7777",
            "http://desk:7777",
        ).forEach { assertTrue(it, isLocalNetworkAddress(it)) }
    }

    @Test
    fun tailscaleAndPublicAddressesAreNotLocal() {
        listOf(
            "http://100.101.102.103:7777",
            "http://[fd7a:115c:a1e0::1]:7777",
            "https://desk.tailnet-name.ts.net",
            "http://172.32.0.1:7777",
            "http://8.8.8.8:7777",
            "http://[2001:db8::1]:7777",
            "not a url",
        ).forEach { assertFalse(it, isLocalNetworkAddress(it)) }
    }
}
