package com.parallelcode.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MergeReadinessTest {
    @Test
    fun readsVerdictChecksAndBranches() {
        val readiness =
            parseMergeReadiness(
                JSONObject(
                    """
                    {"readiness":{"overall":"attention","checks":[
                      {"label":"Merge safety","status":"warning","detail":"main is 2 commits ahead."},
                      {"label":"Verification","status":"warning","detail":"No verification was reported."}]},
                     "canMerge":true,"baseBranch":"main","branchName":"task/thing"}
                    """.trimIndent(),
                ),
            )
        assertEquals("attention", readiness.overall)
        assertTrue(readiness.canMerge)
        assertEquals("main", readiness.baseBranch)
        assertEquals("task/thing", readiness.branchName)
        assertEquals(2, readiness.checks.size)
        assertEquals("Merge safety", readiness.checks[0].label)
        assertEquals("warning", readiness.checks[0].status)
        assertEquals("main is 2 commits ahead.", readiness.checks[0].detail)
    }

    /** A warning must still leave merging possible; only a blocker refuses. */
    @Test
    fun warningVerdictKeepsMergeEnabled() {
        val readiness =
            parseMergeReadiness(
                JSONObject(
                    """{"readiness":{"overall":"attention","checks":[
                       {"label":"Verification","status":"warning","detail":"Stale."}]},
                       "canMerge":true,"baseBranch":"main","branchName":"b"}""",
                ),
            )
        assertEquals("attention", readiness.overall)
        assertTrue(readiness.canMerge)
    }

    @Test
    fun blockedVerdictDisablesMerge() {
        val readiness =
            parseMergeReadiness(
                JSONObject(
                    """{"readiness":{"overall":"blocked","checks":[
                       {"label":"Merge safety","status":"blocked","detail":"Worktree has a detached HEAD."}]},
                       "canMerge":false,"baseBranch":"main","branchName":"b"}""",
                ),
            )
        assertEquals("blocked", readiness.overall)
        assertFalse(readiness.canMerge)
        assertEquals("Worktree has a detached HEAD.", readiness.checks[0].detail)
    }

    /** An absent flag must fail closed, never default to allowing a merge. */
    @Test
    fun missingCanMergeFailsClosed() {
        val readiness =
            parseMergeReadiness(
                JSONObject("""{"readiness":{"overall":"ready","checks":[]},"baseBranch":"main"}"""),
            )
        assertFalse(readiness.canMerge)
        assertTrue(readiness.checks.isEmpty())
    }

    /** An unknown status must not crash the dialog; it renders as neutral. */
    @Test
    fun unknownStatusFallsBackToNeutral() {
        val readiness =
            parseMergeReadiness(
                JSONObject(
                    """{"readiness":{"overall":"ready","checks":[
                       {"label":"PR checks","detail":"No PR checks available."}]},
                       "canMerge":true,"baseBranch":"main","branchName":"b"}""",
                ),
            )
        assertEquals("neutral", readiness.checks[0].status)
        assertEquals("PR checks", readiness.checks[0].label)
    }
}
