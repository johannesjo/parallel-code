package com.parallelcode.phone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalNetworkTest {

    @Test
    fun blockedOnAndroid17UntilGranted() {
        assertTrue(localNetworkBlocked(sdkInt = 37, granted = false))
        assertFalse(localNetworkBlocked(sdkInt = 37, granted = true))
    }

    @Test
    fun olderAndroidNeedsNoGrant() {
        assertFalse(localNetworkBlocked(sdkInt = 36, granted = false))
    }
}
