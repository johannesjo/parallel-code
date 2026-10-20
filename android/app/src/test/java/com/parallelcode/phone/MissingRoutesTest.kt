package com.parallelcode.phone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MissingRoutesTest {
    private val desk = "http://192.168.1.20:7777"
    private val laptop = "http://100.64.0.2:7777"

    @Test
    fun `a 404 marks the route missing on that desktop only`() {
        val routes = MissingRoutes()
        routes.record(desk, 404)
        assertTrue(routes.isMissing(desk))
        assertFalse(routes.isMissing(laptop))
    }

    @Test
    fun `other failures and successes keep asking`() {
        val routes = MissingRoutes()
        for (status in listOf(0, 200, 401, 403, 500, 503)) routes.record(desk, status)
        assertFalse(routes.isMissing(desk))
    }

    @Test
    fun `clearing asks every desktop again`() {
        val routes = MissingRoutes()
        routes.record(desk, 404)
        routes.clear()
        assertFalse(routes.isMissing(desk))
    }
}
