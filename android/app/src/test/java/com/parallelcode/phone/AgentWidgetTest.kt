package com.parallelcode.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentWidgetTest {
    private fun agent(id: String, attention: String, collapsed: Boolean = false) = RemoteAgent(
        agentId = id, taskId = id, taskName = id, running = true, exitCode = null, lastLine = "",
        projectName = null, agentName = null, attention = attention, isChat = false, collapsed = collapsed,
    )

    private fun computer(agents: List<RemoteAgent> = emptyList(), usage: List<ProviderUsage> = emptyList(), label: String = "Desk") =
        ComputerSnapshot(label, agents, usage)

    private fun widgetSummary(
        agents: List<RemoteAgent>,
        usage: List<ProviderUsage>,
        connected: Boolean,
        others: List<List<RemoteAgent>> = emptyList(),
    ) = widgetSummary(computer(agents, usage), connected, others.map { computer(it, label = "Other") })

    @Test
    fun countsAgentsThatNeedYouAndWorking() {
        val agents = listOf(agent("a", "needs_input"), agent("b", "active"), agent("c", "error", collapsed = true))
        assertEquals("1 need you · 1 working", widgetSummary(agents, emptyList(), connected = true).headline)
        assertEquals("1 needs you", widgetSummary(agents.take(1), emptyList(), connected = true).headline)
        assertEquals("Not connected", widgetSummary(agents, emptyList(), connected = false).headline)
    }

    @Test
    fun countsIdleAgentsToo() {
        val agents = listOf(
            agent("a", "needs_input"), agent("b", "active"), agent("c", "idle"), agent("d", "review"),
            agent("e", "idle", collapsed = true),
        )
        assertEquals("1 need you · 1 working · 2 idle", widgetSummary(agents, emptyList(), connected = true).headline)
        assertEquals("1 need you · 2 idle", widgetSummary(agents - agents[1], emptyList(), connected = true).headline)
        assertEquals("2 idle", widgetSummary(agents.drop(2), emptyList(), connected = true).headline)
        assertEquals("No agents running", widgetSummary(agents.takeLast(1), emptyList(), connected = true).headline)
    }

    @Test
    fun sumsEverySavedComputerThatAnswered() {
        val here = listOf(agent("a", "active"), agent("b", "needs_input"))
        val other = listOf(agent("c", "active"), agent("d", "shell_busy"))
        assertEquals(
            "1 need you · 3 working · 2 computers",
            widgetSummary(here, emptyList(), connected = true, others = listOf(other)).headline,
        )
        assertEquals("2 working", widgetSummary(here, emptyList(), connected = false, others = listOf(other)).headline)
        assertEquals(
            "2 working · 2 computers",
            widgetSummary(emptyList(), emptyList(), connected = false, others = listOf(other, emptyList())).headline,
        )
        assertEquals(
            "1 idle · 2 computers",
            widgetSummary(listOf(agent("e", "idle")), emptyList(), connected = true, others = listOf(emptyList())).headline,
        )
    }

    @Test
    fun colorsTheStatusDotByWhatNeedsYouMost() {
        fun tone(vararg attention: String, connected: Boolean = true) =
            widgetSummary(attention.mapIndexed { i, a -> agent("$i", a) }, emptyList(), connected).tone
        assertEquals(WidgetTone.ATTENTION, tone("active", "needs_input"))
        assertEquals(WidgetTone.WORKING, tone("active", "idle"))
        assertEquals(WidgetTone.QUIET, tone("idle"))
        assertEquals(WidgetTone.OFFLINE, tone("active", connected = false))
    }

    @Test
    fun readsTheDesktopAgentList() {
        val raw = """[{"agentId":"a","taskId":"t","taskName":"Fix","status":"running","attention":"active"}]"""
        assertEquals("a", parseAgentList(raw)?.single()?.agentId)
        assertEquals(null, parseAgentList("""{"error":"forbidden"}"""))
    }

    @Test
    fun listsRemainingUsagePerProvider() {
        val usage = listOf(
            ProviderUsage("Claude", UsageWindow(22.0, null), UsageWindow(87.0, null), "ok", null),
            ProviderUsage("Codex", null, null, "ok", null),
        )
        assertEquals(
            listOf(UsageSection(null, listOf("Claude      5h 78%  7d 13%"))),
            widgetSummary(emptyList(), usage, connected = true).usage,
        )
    }

    @Test
    fun groupsUsageUnderEachComputersLabel() {
        val claude = listOf(ProviderUsage("Claude", UsageWindow(22.0, null), UsageWindow(87.0, null), "ok", null))
        val codex = listOf(ProviderUsage("Codex", UsageWindow(50.0, null), null, "ok", null))
        val summary = widgetSummary(
            computer(usage = claude, label = "Desk"),
            connected = true,
            others = listOf(computer(usage = codex, label = "Laptop"), computer(label = "Server")),
        )
        assertEquals(
            listOf(
                UsageSection("Desk", listOf("Claude      5h 78%  7d 13%")),
                UsageSection("Laptop", listOf("Codex       5h 50%")),
            ),
            summary.usage,
        )
        // The last snapshot of the computer in use still shows while it is disconnected.
        assertEquals(
            listOf(UsageSection("Desk", listOf("Claude      5h 78%  7d 13%"))),
            widgetSummary(computer(usage = claude), connected = false, others = listOf(computer(label = "Laptop"))).usage,
        )
    }

    @Test
    fun listsCreditsForProvidersBilledPerUse() {
        val usage = listOf(ProviderUsage("Claude", null, null, "ok", null, CreditUsage(12.34, 50.0, "USD", 24.68)))
        val line = widgetSummary(emptyList(), usage, connected = true).usage.single().lines.last()
        assertTrue(line, line.matches(Regex("Claude {6}credits .*12\\.34 / .*50\\.00")))
    }

    @Test
    fun storesUsageSectionsForTheWidget() {
        val sections = listOf(UsageSection("Desk", listOf("a", "b")), UsageSection(null, listOf("c")))
        assertEquals(sections, decodeUsage(encodeUsage(sections)))
        // What an earlier build stored, or nothing, draws no meters rather than failing.
        assertEquals(emptyList<UsageSection>(), decodeUsage("Left:\nClaude      5h 78%"))
        assertEquals(emptyList<UsageSection>(), decodeUsage(null))
    }

    @Test
    fun snapsTransparencyToTheOfferedStops() {
        assertEquals(100, widgetTransparencyStep(100))
        assertEquals(75, widgetTransparencyStep(80))
        assertEquals(50, widgetTransparencyStep(40))
        assertEquals(25, widgetTransparencyStep(0))
        // Out of range and nonsense values still land on a real stop.
        assertEquals(100, widgetTransparencyStep(140))
        assertEquals(25, widgetTransparencyStep(-10))
    }

    @Test
    fun everyPaletteAndStopHasItsOwnCard() {
        val cards = WIDGET_PALETTES.flatMap { palette ->
            WIDGET_TRANSPARENCY_STEPS.map { palette.background(it) }
        }
        val expected = WIDGET_PALETTES.size * WIDGET_TRANSPARENCY_STEPS.size
        assertEquals(expected, cards.size)
        assertEquals("each color and stop needs its own shape resource", expected, cards.distinct().size)
    }

    @Test
    fun looksUpTheCardForAColorAndStop() {
        assertEquals(WIDGET_PALETTES[1].background(50), widgetBackground("slate", 50))
        // An unknown color falls back to the first palette rather than failing to draw.
        assertEquals(WIDGET_PALETTES.first().background(100), widgetBackground("chartreuse", 100))
        assertEquals(WIDGET_PALETTES.first().background(100), widgetBackground(null, 100))
        // A stop between two values snaps down to a real card.
        assertEquals(widgetBackground("light", 75), widgetBackground("light", 80))
    }

    @Test
    fun everyPaletteKeepsItsTextReadableOnItsCard() {
        // Relative luminance of the card fill, used to pick light or dark text.
        fun channel(value: Int): Double {
            val c = value / 255.0
            return if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }
        fun luminance(color: Int): Double =
            0.2126 * channel((color shr 16) and 0xFF) +
                0.7152 * channel((color shr 8) and 0xFF) +
                0.0722 * channel(color and 0xFF)

        WIDGET_PALETTES.forEach { palette ->
            val card = luminance(palette.fill)
            listOf("title" to palette.title, "headline" to palette.headline, "usage" to palette.usage, "updated" to palette.updated)
                .forEach { (name, text) ->
                    val contrast = (Math.max(card, luminance(text)) + 0.05) / (Math.min(card, luminance(text)) + 0.05)
                    assertTrue("$name on ${palette.label} is only ${"%.1f".format(contrast)}:1", contrast >= 4.5)
                }
        }
    }
}
