package com.parallelcode.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FixCiTest {
    @Test
    fun readsThePrompt() {
        assertEquals("CI failed on pull request #4.", parseFixCiPrompt(JSONObject("""{"prompt":"CI failed on pull request #4."}""")))
    }

    @Test
    fun nullOrBlankMeansNothingFailed() {
        assertNull(parseFixCiPrompt(JSONObject("""{"prompt":null}""")))
        assertNull(parseFixCiPrompt(JSONObject("""{"prompt":"  "}""")))
        assertNull(parseFixCiPrompt(JSONObject("{}")))
    }
}
