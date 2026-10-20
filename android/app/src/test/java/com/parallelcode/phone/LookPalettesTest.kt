package com.parallelcode.phone

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the generated palette file and the mapping from a palette to what the
 * app draws. The desktop owns the real values, so these tests check the contract
 * between the two rather than restating every color: look ids must match the
 * desktop, the tone split must hold, and Obsidian must keep the exact values the
 * app shipped with.
 */
class LookPalettesTest {

    @Test
    fun exposesEveryDesktopLookPreset() {
        val ids = LookPresets.all.map { it.id }
        assertEquals(
            listOf(
                "parallel-code",
                "noir",
                "obsidian",
                "obsidian-light",
                "islands-dark",
                "islands-light",
                "minimal",
                "graphite",
                "midnight",
                "classic",
                "indigo",
                "ember",
                "glacier",
                "zenburnesque",
                "catppuccin-mocha",
                "workbench",
            ),
            ids,
        )
    }

    @Test
    fun idsAreUnique() {
        val ids = LookPresets.all.map { it.id }
        assertEquals(ids.size, ids.toSet().size)
    }

    @Test
    fun everyPresetHasLabelAndDescription() {
        LookPresets.all.forEach { preset ->
            assertTrue("${preset.id} label", preset.label.isNotBlank())
            assertTrue("${preset.id} description", preset.description.isNotBlank())
        }
    }

    /** Two light looks exist; the rest are dark, matching the desktop's tones. */
    @Test
    fun splitsPresetsByTone() {
        assertEquals(
            listOf("obsidian-light", "islands-light"),
            LookPresets.light.map { it.id },
        )
        assertEquals(LookPresets.all.size - 2, LookPresets.dark.size)
        assertFalse(LookPresets.dark.any { !it.dark })
        assertTrue(LookPresets.light.none { it.dark })
    }

    @Test
    fun defaultsToObsidianPerTone() {
        assertEquals("obsidian", LookPresets.defaultForDark().id)
        assertEquals("obsidian-light", LookPresets.defaultForLight().id)
        assertEquals("obsidian", LookPresets.defaultFor(dark = true).id)
        assertEquals("obsidian-light", LookPresets.defaultFor(dark = false).id)
    }

    @Test
    fun byIdResolvesKnownPreset() {
        assertEquals("ember", LookPresets.byId("ember").id)
    }

    @Test
    fun byIdFallsBackForUnknownId() {
        assertEquals("obsidian", LookPresets.byId("no-such-look").id)
        assertEquals("obsidian-light", LookPresets.byId(null, LookPresets.defaultForLight()).id)
    }

    @Test
    fun isKnownRejectsUnknownAndNull() {
        assertTrue(LookPresets.isKnown("workbench"))
        assertFalse(LookPresets.isKnown("solarized"))
        assertFalse(LookPresets.isKnown(null))
    }

    /** The core invariant: the tone passed in always matches the preset returned. */
    @Test
    fun forToneNeverReturnsAPresetOfTheWrongTone() {
        LookPresets.all.forEach { preset ->
            assertTrue("${preset.id} in dark", LookPresets.forTone(true, preset.id).dark)
            assertFalse("${preset.id} in light", LookPresets.forTone(false, preset.id).dark)
        }
    }

    @Test
    fun forToneKeepsMatchingPreset() {
        assertEquals("ember", LookPresets.forTone(dark = true, id = "ember").id)
        assertEquals("islands-light", LookPresets.forTone(dark = false, id = "islands-light").id)
    }

    /**
     * Obsidian is the default, so its values are pinned here: these are the exact
     * colors the app shipped with, and a generator change must not move them.
     */
    @Test
    fun obsidianKeepsItsShippedColors() {
        val obsidian = LookPresets.byId("obsidian")
        assertEquals(Color(0xFF171717), obsidian.bg)
        assertEquals(Color(0xFF242424), obsidian.bgElevated)
        assertEquals(Color(0xFF262626), obsidian.bgInput)
        assertEquals(Color(0xFF1E1E1E), obsidian.islandBg)
        assertEquals(Color(0xFF333333), obsidian.border)
        assertEquals(Color(0xFF292929), obsidian.borderSubtle)
        assertEquals(Color(0xFFEDEDED), obsidian.fg)
        assertEquals(Color(0xFFB5B5B5), obsidian.fgMuted)
        assertEquals(Color(0xFF919191), obsidian.fgSubtle)
        assertEquals(Color(0xFFC4A77D), obsidian.accent)
        assertEquals(Color(0xFF1E1B16), obsidian.accentText)
        assertEquals(Color(0xFF98C9AE), obsidian.success)
        assertEquals(Color(0xFFEAA0AA), obsidian.error)
        assertEquals(Color(0xFFF29B70), obsidian.warning)
        assertEquals(Color(0xFFC1B0E8), obsidian.review)
    }

    @Test
    fun obsidianLightKeepsItsShippedColors() {
        val light = LookPresets.byId("obsidian-light")
        assertEquals(Color(0xFFF4F4F2), light.bg)
        assertEquals(Color(0xFF1F1F1F), light.fg)
        assertEquals(Color(0xFF8A6433), light.accent)
        assertEquals(Color(0xFF2F7D4F), light.success)
        assertEquals(Color(0xFFAD4E00), light.warning)
    }

    /** Obsidian is the square-edged look; the others keep their own radii. */
    @Test
    fun obsidianStaysSquareAndOthersKeepRadius() {
        val obsidian = LookPresets.byId("obsidian")
        assertEquals(0f, obsidian.radiusIsland.value)
        assertEquals(0f, obsidian.radiusMd.value)
        assertTrue(LookPresets.byId("noir").radiusIsland.value > 0f)
        assertTrue(LookPresets.byId("noir").radiusMd.value > 0f)
    }

    /** Flat surfaces cannot show a gradient, so each palette has one solid bg. */
    @Test
    fun everyPaletteHasFullyOpaqueSurfaces() {
        LookPresets.all.forEach { preset ->
            listOf(
                "bg" to preset.bg,
                "bgElevated" to preset.bgElevated,
                "bgInput" to preset.bgInput,
                "islandBg" to preset.islandBg,
                "panelBg" to preset.panelBg,
                "fg" to preset.fg,
                "accent" to preset.accent,
            ).forEach { (name, color) ->
                assertEquals("${preset.id}.$name opaque", 1f, color.alpha, 0.001f)
            }
        }
    }

    /** Diff tints are the one place alpha carries meaning, so they stay translucent. */
    @Test
    fun diffTintsStayTranslucent() {
        LookPresets.all.forEach { preset ->
            assertTrue("${preset.id} diffAddBg", preset.diffAddBg.alpha in 0.05f..0.4f)
            assertTrue("${preset.id} diffRemoveBg", preset.diffRemoveBg.alpha in 0.05f..0.4f)
        }
    }

    @Test
    fun presetsAreVisuallyDistinct() {
        // Guards against a generator change collapsing two looks into one palette.
        // Graphite and Midnight share a background on purpose (Midnight only changes
        // the terminal panel), so panelBg is the signal that separates them.
        val signatures =
            LookPresets.all.map { it.id to listOf(it.bg, it.accent, it.fg, it.islandBg, it.panelBg) }
        for (i in signatures.indices) {
            for (j in i + 1 until signatures.size) {
                assertNotEquals(
                    "${signatures[i].first} and ${signatures[j].first} look identical",
                    signatures[i].second,
                    signatures[j].second,
                )
            }
        }
    }

    @Test
    fun blendOverMixesTowardTopColor() {
        val base = Color(0xFF000000)
        assertEquals(Color(0xFF000000), blendOver(base, Color(0xFFFFFFFF), 0f))
        assertEquals(Color(0xFFFFFFFF), blendOver(base, Color(0xFFFFFFFF), 1f))
        val half = blendOver(Color(0xFF000000), Color(0xFFFFFFFF), 0.5f)
        assertEquals(0.5f, half.red, 0.01f)
    }

    @Test
    fun blendOverKeepsBaseAlpha() {
        val blended = blendOver(Color(0x33000000), Color(0xFFFFFFFF), 0.5f)
        assertEquals(0x33 / 255f, blended.alpha, 0.01f)
    }

    @Test
    fun blendOverClampsOutOfRangeAlpha() {
        val base = Color(0xFF000000)
        assertEquals(base, blendOver(base, Color(0xFFFFFFFF), -1f))
        assertEquals(Color(0xFFFFFFFF), blendOver(base, Color(0xFFFFFFFF), 5f))
    }

    @Test
    fun withAlphaSetsOpacityDirectly() {
        assertEquals(0.2f, withAlpha(Color(0xFFC4A77D), 0.2f).alpha, 0.001f)
        assertEquals(0f, withAlpha(Color(0xFFC4A77D), -1f).alpha, 0.001f)
    }

    /**
     * The attention tints are blended from the palette rather than hand-picked, so
     * Obsidian must land on the values it shipped with. Blending happens in float
     * and then quantizes, so channels are compared within one 8-bit step.
     */
    @Test
    fun obsidianAttentionTintsMatchShippedValues() {
        val extra = extendedColorsFor(LookPresets.byId("obsidian"))
        assertColorNear(Color(0xFF2F2825), extra.cardBgAttention, "cardBgAttention")
        assertColorNear(Color(0xFF885C47), extra.attentionBorder, "attentionBorder")
        assertColorNear(Color(0xFF372D28), extra.warningBannerBg, "warningBannerBg")
        // The wash is the warning hue itself at 20% alpha, not a blend onto a surface.
        assertEquals(0x33 / 255f, extra.attentionBg.alpha, 0.001f)
        assertColorNear(Color(0xFFF29B70), extra.attentionBg, "attentionBg")
    }

    /** Asserts two colors match to within one 8-bit step per channel. */
    private fun assertColorNear(expected: Color, actual: Color, label: String) {
        val tolerance = 1f / 255f
        assertEquals("$label red", expected.red, actual.red, tolerance)
        assertEquals("$label green", expected.green, actual.green, tolerance)
        assertEquals("$label blue", expected.blue, actual.blue, tolerance)
    }

    @Test
    fun extendedColorsCarryThePaletteThrough() {
        LookPresets.all.forEach { preset ->
            val extra = extendedColorsFor(preset)
            assertEquals(preset.dark, extra.dark)
            assertEquals(preset.border, extra.border)
            assertEquals(preset.borderSubtle, extra.borderSubtle)
            assertEquals(preset.bgInput, extra.inputBg)
            assertEquals(preset.islandBg, extra.cardBg)
            assertEquals(preset.fg, extra.textPrimary)
            assertEquals(preset.fgMuted, extra.textMuted)
            assertEquals(preset.fgSubtle, extra.textSubtle)
            assertEquals(preset.warning, extra.warningText)
            assertEquals(preset.success, extra.success)
            assertEquals(preset.review, extra.review)
            assertEquals(preset.radiusIsland, extra.cardRadius)
        }
    }

    @Test
    fun colorSchemeFollowsThePaletteTone() {
        LookPresets.all.forEach { preset ->
            val scheme = colorSchemeFor(preset)
            assertEquals("${preset.id} background", preset.bg, scheme.background)
            assertEquals("${preset.id} onBackground", preset.fg, scheme.onBackground)
            assertEquals("${preset.id} primary", preset.accent, scheme.primary)
            assertEquals("${preset.id} onPrimary", preset.accentText, scheme.onPrimary)
            assertEquals("${preset.id} error", preset.error, scheme.error)
            assertEquals("${preset.id} outline", extendedColorsFor(preset).border, scheme.outline)
            assertEquals(1f, scheme.background.alpha, 0.001f)
        }
    }

    @Test
    fun accentContainerIsAQuietWashOfTheAccent() {
        val preset = LookPresets.byId("obsidian")
        val container = colorSchemeFor(preset).primaryContainer
        // Blended toward the island background, so it sits between the two.
        assertTrue(container.red > preset.islandBg.red)
        assertTrue(container.red < preset.accent.red)
    }

    @Test
    fun shapesFollowThePaletteRadii() {
        LookPresets.all.forEach { preset ->
            val shapes = shapesFor(preset)
            // Each slot must be a uniform RoundedCornerShape at the palette's radius,
            // which is what shapesFor builds.
            val slots =
                listOf(
                    Triple("extraSmall", shapes.extraSmall as RoundedCornerShape, preset.radiusXs),
                    Triple("small", shapes.small as RoundedCornerShape, preset.radiusSm),
                    Triple("medium", shapes.medium as RoundedCornerShape, preset.radiusMd),
                    Triple("large", shapes.large as RoundedCornerShape, preset.radiusLg),
                    Triple("extraLarge", shapes.extraLarge as RoundedCornerShape, preset.radiusLg),
                )
            slots.forEach { (slot, corners, radius) ->
                val expected = RoundedCornerShape(radius)
                assertEquals("${preset.id}.$slot", expected, corners)
            }
        }
    }

    /**
     * The widget draws in RemoteViews and cannot read the Compose theme, so its
     * Obsidian and Light cards carry their own color literals. Those two mirror the
     * matching presets; this keeps a desktop recolor from leaving the widget stale.
     */
    @Test
    fun widgetCardsMirrorTheObsidianAndLightPresets() {
        val obsidianWidget = widgetPalette("obsidian")
        val obsidian = LookPresets.byId(LookPresets.PRESET_OBSIDIAN)
        assertEquals(obsidian.islandBg.argb(), obsidianWidget.fill)
        assertEquals(obsidian.accent.argb(), obsidianWidget.title)
        assertEquals(obsidian.fg.argb(), obsidianWidget.headline)
        assertEquals(obsidian.fgMuted.argb(), obsidianWidget.usage)
        assertEquals(obsidian.fgSubtle.argb(), obsidianWidget.updated)

        val lightWidget = widgetPalette("light")
        val light = LookPresets.byId(LookPresets.PRESET_OBSIDIAN_LIGHT)
        assertEquals(light.islandBg.argb(), lightWidget.fill)
        assertEquals(light.accent.argb(), lightWidget.title)
        assertEquals(light.fg.argb(), lightWidget.headline)
        assertEquals(light.fgMuted.argb(), lightWidget.usage)
        assertEquals(light.fgSubtle.argb(), lightWidget.updated)
    }

    /**
     * A [Color]'s 0xAARRGGBB int, which is how the widget and the terminal store
     * their colors. Written out rather than via `android.graphics.Color`, which is
     * not mocked in plain JVM unit tests.
     */
    private fun Color.argb(): Int = paletteArgb(this)

/**
 * An opaque 0xAARRGGBB color as a Kotlin [Int]. A hex literal above Int.MAX_VALUE is
 * a Long, so terminal and widget colors (always opaque) need this to be compared.
 */
private fun opaque(rgb: Long): Int = (0xFF000000L or rgb).toInt()

/** The 0xAARRGGBB [Int] form of a [Color], as the widget and terminal store them. */
private fun paletteArgb(color: Color): Int =
    ((color.alpha * 255).toInt() shl 24) or
        ((color.red * 255).toInt() shl 16) or
        ((color.green * 255).toInt() shl 8) or
        (color.blue * 255).toInt()

    /**
     * Terminals follow the look, as on the desktop: light presets share one ANSI
     * set, the three dark looks that have their own keep them, and the rest fall
     * back to the muted dark set.
     */
    @Test
    fun terminalThemesMatchTheDesktopPairing() {
        val expected = mapOf(
            "parallel-code" to "noir",
            "noir" to "noir",
            "obsidian" to "obsidian",
            "islands-dark" to "islands-dark",
            // Every light preset shares one set, as getTerminalTheme does.
            "obsidian-light" to "light",
            "islands-light" to "light",
            // Dark presets with no set of their own fall back.
            "graphite" to "noir",
            "midnight" to "noir",
            "catppuccin-mocha" to "noir",
            "workbench" to "noir",
        )
        expected.forEach { (presetId, terminalId) ->
            assertEquals(
                "$presetId terminal theme",
                terminalId,
                LookPresets.byId(presetId).terminalThemeId,
            )
        }
    }

    @Test
    fun everyTerminalThemeIdResolves() {
        LookPresets.all.forEach { preset ->
            assertTrue(
                "${preset.id} terminal theme ${preset.terminalThemeId}",
                ALL_TERMINAL_THEMES.containsKey(preset.terminalThemeId),
            )
        }
    }

    @Test
    fun terminalThemesCarrySixteenAnsiColors() {
        ALL_TERMINAL_THEMES.forEach { (id, theme) ->
            assertEquals("$id ansi size", 16, theme.ansi.size)
            // A terminal color is opaque; a transparent ANSI slot would render as a hole.
            theme.ansi.forEach { assertEquals("$id ansi opaque", 0xFF, it ushr 24) }
            assertEquals("$id foreground opaque", 0xFF, theme.foreground ushr 24)
        }
    }

    @Test
    fun terminalPalettesTakeTheLooksPanelBackground() {
        LookPresets.all.forEach { preset ->
            val terminal = TerminalPalette.forLook(preset)
            assertEquals(
                "${preset.id} terminal background",
                paletteArgb(preset.panelBg),
                terminal.background,
            )
        }
    }

    /**
     * Obsidian's terminal keeps the exact colors the app shipped with. Checked
     * through [TerminalPalette.resolve] so the SGR packing is covered too.
     */
    @Test
    fun obsidianTerminalKeepsItsShippedAnsi() {
        val terminal = TerminalPalette.forLook(LookPresets.byId("obsidian"))

        val default = terminal.resolve(CellStyle.of(CellStyle.DEFAULT_COLOR, CellStyle.DEFAULT_COLOR, 0))
        // No color set: the palette's default foreground.
        assertEquals(opaque(0xFFE4E4E4), default.foreground)
        // The background is the look's own panel, not a fixed terminal color.
        assertEquals(paletteArgb(LookPresets.byId("obsidian").panelBg), terminal.background)
        // ANSI slots, plain and bright, in the order TerminalStyle indexes them.
        val expectedAnsi = listOf(
            0xFF2E2E2E, 0xFFE08C96, 0xFF98C9AE, 0xFFDFC18E, 0xFF8FB3DC, 0xFFC1B0E8, 0xFF8EC9C9,
            0xFFC9C9C9, 0xFF858585, 0xFFEAA0AA, 0xFFADDCC1, 0xFFEAD3A8, 0xFFA8C5E8, 0xFFD2C4F0,
            0xFFA6DADA, 0xFFEDEDED,
        ).map(::opaque)
        expectedAnsi.forEachIndexed { slot, expected ->
            val style = CellStyle.of(slot, CellStyle.DEFAULT_COLOR, 0)
            assertEquals("ansi slot $slot", expected, terminal.resolve(style).foreground)
        }
    }

    /** Bold text in the first eight colors uses the bright variant, as xterm does. */
    @Test
    fun boldAnsiTextUsesTheBrightVariant() {
        val terminal = TerminalPalette.forLook(LookPresets.byId("obsidian"))
        val boldRed = CellStyle.of(1, CellStyle.DEFAULT_COLOR, CellStyle.BOLD)
        assertEquals(opaque(0xFFEAA0AA), terminal.resolve(boldRed).foreground)
    }

    @Test
    fun midnightDiffersFromGraphiteOnlyInThePanel() {
        // Midnight is Graphite with a pure-black terminal panel; the two must not
        // be the same preset, or the desktop's distinction is lost.
        val graphite = LookPresets.byId("graphite")
        val midnight = LookPresets.byId("midnight")
        assertNotEquals(graphite.panelBg, midnight.panelBg)
        assertEquals(graphite.accent, midnight.accent)
    }
}
