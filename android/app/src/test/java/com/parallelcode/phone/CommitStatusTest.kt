package com.parallelcode.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommitStatusTest {
    @Test
    fun readsFilesAndCountsStaged() {
        val status =
            parseCommitStatus(
                JSONObject(
                    """{"files":[
                       {"path":"src/a.ts","status":"M","staged":true},
                       {"path":"src/b.ts","status":"?","staged":false},
                       {"path":"src/c.ts","status":"D","staged":false}]}""",
                ),
            )
        assertFalse(status.unsupported)
        assertEquals(3, status.files.size)
        assertEquals(CommitFile("src/a.ts", "M", true), status.files[0])
        assertEquals(1, status.stagedCount)
        assertEquals(2, status.unstagedCount)
    }

    @Test
    fun readsUnsupportedTask() {
        val status = parseCommitStatus(JSONObject("""{"files":[],"unsupported":true}"""))
        assertTrue(status.unsupported)
        assertTrue(status.files.isEmpty())
    }

    /** A missing staged flag must not let a file count as staged. */
    @Test
    fun missingFieldsFallBackToUnstagedAndEmpty() {
        val status = parseCommitStatus(JSONObject("""{"files":[{"path":"x"}]}"""))
        assertFalse(status.files[0].staged)
        assertEquals(0, status.stagedCount)
        assertTrue(parseCommitStatus(JSONObject("{}")).files.isEmpty())
    }
}
