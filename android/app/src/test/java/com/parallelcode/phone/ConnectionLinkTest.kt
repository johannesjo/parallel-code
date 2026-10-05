package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionLinkTest {
    @Test
    fun parsesTheDesktopQrUrl() {
        val link = ConnectionLink.parse("http://192.168.1.20:7777?token=abc")
        assertEquals(ConnectionLink("http://192.168.1.20:7777", "abc"), link)
        assertEquals("ws://192.168.1.20:7777/ws", link?.webSocketUrl)
    }

    @Test
    fun keepsOnlyOriginAndDecodesTheToken() {
        val link = ConnectionLink.parse("  https://desk.tail1.ts.net/?x=1&token=a%2Bb_c  ")
        assertEquals(ConnectionLink("https://desk.tail1.ts.net", "a+b_c"), link)
        assertEquals("wss://desk.tail1.ts.net/ws", link?.webSocketUrl)
    }

    @Test
    fun rejectsLinksThatCannotReachADesktop() {
        assertNull(ConnectionLink.parse("http://192.168.1.20:7777"))
        assertNull(ConnectionLink.parse("http://192.168.1.20:7777?token="))
        assertNull(ConnectionLink.parse("ftp://host?token=abc"))
        assertNull(ConnectionLink.parse("javascript:alert(1)?token=abc"))
        assertNull(ConnectionLink.parse("not a url"))
        assertNull(ConnectionLink.parse("http://host?token=" + "a".repeat(201)))
    }
}
