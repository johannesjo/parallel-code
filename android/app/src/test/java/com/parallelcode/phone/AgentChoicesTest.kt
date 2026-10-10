package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class AgentChoicesTest {
    @Test
    fun readsAgentsWithTheirModels() {
        val agents = parseAgentChoices(
            """
            [{"id":"claude","name":"Claude Code","isDefault":true,
              "models":[{"id":"opus","label":"opus"},{"id":"gpt-5","label":""}]},
             {"id":"gemini","name":"Gemini","isDefault":false,"models":[]}]
            """.trimIndent(),
        )
        assertEquals(
            listOf(
                MobileAgentChoice(
                    "claude",
                    "Claude Code",
                    true,
                    // A blank label falls back to the model id.
                    listOf(AgentModel("opus", "opus"), AgentModel("gpt-5", "gpt-5")),
                ),
                MobileAgentChoice("gemini", "Gemini", false, emptyList()),
            ),
            agents,
        )
    }

    @Test
    fun treatsMissingFieldsAsNoModelsAndNotDefault() {
        assertEquals(
            listOf(MobileAgentChoice("codex", "Codex", false, emptyList())),
            parseAgentChoices("""[{"id":"codex","name":"Codex"}]"""),
        )
    }
}
