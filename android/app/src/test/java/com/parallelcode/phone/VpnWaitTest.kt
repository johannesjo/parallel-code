package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VpnWaitTest {

    @Test
    fun waitsWithoutVpnOffHomeWifi() {
        assertTrue(waitsForVpn(waitForVpn = true, vpnActive = false, wifiSsid = "Cafe", homeWifiSsid = "Home"))
        assertTrue(waitsForVpn(waitForVpn = true, vpnActive = false, wifiSsid = null, homeWifiSsid = "Home"))
        assertTrue(waitsForVpn(waitForVpn = true, vpnActive = false, wifiSsid = "Home", homeWifiSsid = null))
    }

    @Test
    fun skipsWaitingOnHomeWifi() {
        assertFalse(waitsForVpn(waitForVpn = true, vpnActive = false, wifiSsid = "Home", homeWifiSsid = "Home"))
    }

    @Test
    fun neverWaitsWhenVpnIsUpOrSettingIsOff() {
        assertFalse(waitsForVpn(waitForVpn = true, vpnActive = true, wifiSsid = "Cafe", homeWifiSsid = "Home"))
        assertFalse(waitsForVpn(waitForVpn = false, vpnActive = false, wifiSsid = "Cafe", homeWifiSsid = "Home"))
    }

    @Test
    fun normalizesAndroidSsids() {
        assertEquals("Home", NetworkMonitor.normalizeSsid("\"Home\""))
        assertEquals(null, NetworkMonitor.normalizeSsid("<unknown ssid>"))
        assertEquals(null, NetworkMonitor.normalizeSsid(null))
    }
}
