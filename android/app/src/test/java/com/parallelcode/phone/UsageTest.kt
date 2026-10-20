package com.parallelcode.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.Locale

class UsageTest {
    @Test
    fun showsProvidersWithASnapshotOrARefreshError() {
        val usage = parseUsage(
            JSONObject(
                """{
                "claude": {"fiveHour": {"usedPercent": 82.4, "resetsAt": 1700000000000},
                           "sevenDay": {"usedPercent": 10, "resetsAt": null},
                           "fetchedAt": 1, "status": "ok", "error": null},
                "codex": {"fiveHour": null, "sevenDay": null, "fetchedAt": null,
                          "status": "error", "error": "rate limited"}
                }""",
            ),
        )
        val (claude, codex) = usage
        assertEquals("Claude", claude.label)
        assertEquals(18, claude.fiveHour?.remainingPercent)
        assertTrue(claude.fiveHour?.warn == true)
        assertEquals(null, claude.sevenDay?.resetsAt)
        assertEquals("rate limited", codex.error)
    }

    @Test
    fun showsAntigravityUsageWhenAvailable() {
        val usage = parseUsage(
            JSONObject(
                """{
                "antigravity": {
                    "fiveHour": {"usedPercent": 40.0, "resetsAt": 1700000000000},
                    "sevenDay": {"usedPercent": 15.0, "resetsAt": null},
                    "fetchedAt": 1,
                    "status": "ok",
                    "error": null
                }
                }""",
            ),
        )
        assertEquals(1, usage.size)
        val agy = usage.first()
        assertEquals("Antigravity", agy.label)
        assertEquals(60, agy.fiveHour?.remainingPercent)
        assertEquals(85, agy.sevenDay?.remainingPercent)
    }

    @Test
    fun showsCreditsForLoginsWithoutRateLimitWindows() {
        val usage = parseUsage(
            JSONObject(
                """{
                "claude": {"fiveHour": null, "sevenDay": null,
                           "creditUsage": {"used": 45, "limit": 50, "currency": "USD", "usedPercent": 90},
                           "fetchedAt": 1, "status": "ok", "error": null}
                }""",
            ),
        )
        val credit = usage.single().creditUsage
        assertEquals(CreditUsage(45.0, 50.0, "USD", 90.0), credit)
        assertTrue(credit?.warn == true)
        assertEquals("\$45.00 / \$50.00", credit?.let { formatCredit(it, Locale.US) })
    }

    @Test
    fun formatsCreditsWithoutACap() {
        assertEquals("\$9.00 used", formatCredit(CreditUsage(9.0, null, "USD", null), Locale.US))
    }

    @Test
    fun hidesProvidersWithoutASubscription() {
        val none = """{"fiveHour": null, "sevenDay": null, "fetchedAt": null, "status": "unavailable", "error": null}"""
        assertEquals(emptyList<ProviderUsage>(), parseUsage(JSONObject("""{"claude": $none, "codex": $none, "antigravity": $none}""")))
    }

    @Test
    fun formatsResetTimes() {
        val zone = ZoneOffset.UTC
        val now = ZonedDateTime.of(2026, 9, 28, 10, 0, 0, 0, zone).toInstant().toEpochMilli()
        fun at(day: Int, hour: Int) = ZonedDateTime.of(2026, 9, day, hour, 30, 0, 0, zone).toInstant().toEpochMilli()
        assertEquals("resets 14:30", formatReset(at(28, 14), now, zone, Locale.US))
        val thursday = ZonedDateTime.of(2026, 10, 1, 9, 30, 0, 0, zone).toInstant().toEpochMilli()
        assertEquals("resets Thu 09:30", formatReset(thursday, now, zone, Locale.US))
        assertEquals("reset due", formatReset(at(28, 9), now, zone, Locale.US))
        assertEquals("", formatReset(null, now, zone, Locale.US))
    }
}
