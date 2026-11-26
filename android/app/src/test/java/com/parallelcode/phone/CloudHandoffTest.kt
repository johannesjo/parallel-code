package com.parallelcode.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class CloudHandoffTest {
    @Test
    fun readsAnAvailableHandoff() {
        val json = JSONObject(
            """{"available":true,"prompt":"Continue this task: Fix login","branchName":"task/fix-login","canPush":true}""",
        )
        assertEquals(
            CloudHandoff(true, "Continue this task: Fix login", "task/fix-login", true),
            parseCloudHandoff(json),
        )
    }

    @Test
    fun keepsTheDesktopReasonWhenUnavailable() {
        val json = JSONObject("""{"available":false,"reason":"Only Claude Code tasks outside Docker can continue in the cloud."}""")
        assertEquals("Only Claude Code tasks outside Docker can continue in the cloud.", parseCloudHandoff(json).reason)
    }

    @Test
    fun readsAnUnknownAnswerAsUnavailable() {
        val handoff = parseCloudHandoff(JSONObject("{}"))
        assertFalse(handoff.available)
        assertEquals("This task cannot continue in the cloud.", handoff.reason)
    }
}
