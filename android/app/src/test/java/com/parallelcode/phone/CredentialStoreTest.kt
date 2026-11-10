package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CredentialStoreTest {
    private val home = ConnectionLink("http://192.168.1.20:7777", "home-token")
    private val dev = ConnectionLink("http://192.168.1.20:8777", "dev-token")

    @Test
    fun keepsEachComputerWithItsOwnPairing() {
        val store = CredentialStore(FakeSharedPreferences())
        store.saveLink(home)
        store.savePairedToken("home-paired")
        store.saveLink(dev)
        assertEquals(dev, store.link)
        assertNull(store.pairedToken)

        store.select(home.baseUrl)
        assertEquals(home, store.link)
        assertEquals("home-paired", store.pairedToken)
        assertEquals(listOf("192.168.1.20:7777", "192.168.1.20:8777"), store.computers.map { it.label }.sorted())
    }

    @Test
    fun switchesTheSameComputerToItsTailscaleAddressAndBack() {
        val prefs = FakeSharedPreferences()
        val store = CredentialStore(prefs)
        val tailscale = "http://100.101.102.103:7777"
        store.saveLink(home)
        store.savePairedToken("home-paired")
        store.rename(home.baseUrl, "Desk")
        assertNull(store.computers.single().otherNetworkUrl)

        store.saveAddresses(wifiUrl = home.baseUrl, tailscaleUrl = tailscale)
        store.switchNetwork()
        assertEquals(ConnectionLink(tailscale, "home-token"), store.link)
        assertEquals("home-paired", store.pairedToken)
        assertEquals("Desk", store.computers.single().label)
        assertEquals(true, store.computers.single().onTailscale)

        // Survives a restart of the app.
        val reopened = CredentialStore(prefs)
        assertEquals(home.baseUrl, reopened.computers.single().otherNetworkUrl)
        reopened.switchNetwork()
        assertEquals(home, reopened.link)
        assertEquals("home-paired", reopened.pairedToken)
    }

    @Test
    fun switchingMergesASeparatelyScannedTailscaleEntry() {
        val store = CredentialStore(FakeSharedPreferences())
        val tailscale = ConnectionLink("http://100.101.102.103:7777", "home-token")
        store.saveLink(tailscale)
        store.saveLink(home)
        store.savePairedToken("home-paired")
        store.saveAddresses(wifiUrl = home.baseUrl, tailscaleUrl = tailscale.baseUrl)
        store.switchNetwork()
        assertEquals(listOf(tailscale.baseUrl), store.computers.map { it.baseUrl })
        assertEquals("home-paired", store.pairedToken)
    }

    @Test
    fun keepsTheTailscaleAddressWhenTheDesktopBrieflyReportsNone() {
        val store = CredentialStore(FakeSharedPreferences())
        store.saveLink(home)
        store.saveAddresses(wifiUrl = home.baseUrl, tailscaleUrl = "http://100.101.102.103:7777")
        store.saveAddresses(wifiUrl = home.baseUrl, tailscaleUrl = null)
        assertEquals("http://100.101.102.103:7777", store.computers.single().otherNetworkUrl)
    }

    @Test
    fun ignoresMalformedReportedAddresses() {
        val store = CredentialStore(FakeSharedPreferences())
        store.saveLink(home)
        store.saveAddresses(wifiUrl = home.baseUrl, tailscaleUrl = "garbage")
        assertNull(store.computers.single().otherNetworkUrl)
        store.saveAddresses(wifiUrl = home.baseUrl, tailscaleUrl = "http://100.101.102.103:7777/x?y")
        assertNull(store.computers.single().otherNetworkUrl)
    }

    @Test
    fun switchingKeepsThePairingAndNameOfASeparatelySavedTailscaleEntry() {
        val store = CredentialStore(FakeSharedPreferences())
        val tailscale = ConnectionLink("http://100.101.102.103:7777", "home-token")
        store.saveLink(tailscale)
        store.savePairedToken("tailscale-paired")
        store.rename(tailscale.baseUrl, "Desk")
        store.saveLink(home)
        store.saveAddresses(wifiUrl = home.baseUrl, tailscaleUrl = tailscale.baseUrl)
        store.switchNetwork()
        assertEquals("tailscale-paired", store.pairedToken)
        assertEquals("Desk", store.computers.single().label)
    }

    @Test
    fun offersNoSwitchWhenConnectedThroughAnotherAddress() {
        val store = CredentialStore(FakeSharedPreferences())
        val served = ConnectionLink("https://desk.tail1234.ts.net", "home-token")
        store.saveLink(served)
        store.saveAddresses(wifiUrl = home.baseUrl, tailscaleUrl = "http://100.101.102.103:7777")
        assertNull(store.computers.single().otherNetworkUrl)
        store.switchNetwork()
        assertEquals(served, store.link)
    }

    @Test
    fun labelsDefaultToTheAddressAndRenamePersists() {
        val store = CredentialStore(FakeSharedPreferences())
        store.saveLink(home)
        assertEquals("192.168.1.20:7777", store.computers.single().label)

        store.rename(home.baseUrl, "Home server")
        assertEquals("Home server", store.computers.single().label)

        store.rename(home.baseUrl, "  ")
        assertEquals("192.168.1.20:7777", store.computers.single().label)
    }

    @Test
    fun rescanningAnAddressKeepsItsLabelButDropsPairing() {
        val store = CredentialStore(FakeSharedPreferences())
        store.saveLink(home)
        store.savePairedToken("old")
        store.rename(home.baseUrl, "Home server")
        store.saveLink(home.copy(token = "new"))
        assertEquals("Home server", store.computers.single().label)
        assertNull(store.pairedToken)
    }

    @Test
    fun forgettingTheComputerInUseLeavesNoneSelected() {
        val store = CredentialStore(FakeSharedPreferences())
        store.saveLink(home)
        store.saveLink(dev)
        store.clear()
        assertNull(store.link)
        assertEquals(listOf(home.baseUrl), store.computers.map { it.baseUrl })
    }

    @Test
    fun rescanningAnAddressReplacesItsTokenAndDropsPairing() {
        val store = CredentialStore(FakeSharedPreferences())
        store.saveLink(home)
        store.savePairedToken("old")
        store.saveLink(home.copy(token = "new"))
        assertEquals(1, store.computers.size)
        assertEquals("new", store.link?.token)
        assertNull(store.pairedToken)
    }

    @Test
    fun migratesTheSingleComputerFromEarlierVersions() {
        val prefs = FakeSharedPreferences()
        prefs.edit().putString("baseUrl", home.baseUrl).putString("token", home.token)
            .putString("pairedToken", "kept").commit()
        val store = CredentialStore(prefs)
        assertEquals(home, store.link)
        assertEquals("kept", store.pairedToken)
        assertNull(prefs.getString("baseUrl", null))
    }
}
