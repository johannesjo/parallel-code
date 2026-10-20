package com.parallelcode.phone

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The phone's theme, driven by a [LookPalette] generated from the desktop app
 * (see LookPalettes.kt). Pick a palette with [ParallelCodeTheme] and read the
 * colors that Material3 has no slot for through [AppTheme.extra].
 *
 * Derived tints (the "needs you" attention wash, warning banners, containers)
 * are blended from the palette here instead of being hand-picked per theme, so a
 * new preset gets correct tints for free.
 */
@Immutable
data class ExtendedColors(
    /** The active preset's own light/dark choice, which can differ from the phone's. */
    val dark: Boolean,
    val border: Color,
    val borderSubtle: Color,
    val borderFocus: Color,
    val inputBg: Color,
    val bgHover: Color,
    val bgSelected: Color,
    val cardBg: Color,
    val cardBgAttention: Color,
    val attentionBorder: Color,
    val attentionBg: Color,
    val warningBannerBg: Color,
    val warningText: Color,
    val link: Color,
    val success: Color,
    val error: Color,
    val review: Color,
    val info: Color,
    val textPrimary: Color,
    val textMuted: Color,
    val textSubtle: Color,
    val diffAddBg: Color,
    val diffRemoveBg: Color,
    /** Corner radius for cards and panels, from the preset's `--island-radius`. */
    val cardRadius: Dp,
)

/**
 * Composites [top] over [base] at [alpha] (0..1), keeping [base]'s alpha. This
 * is the phone's stand-in for CSS `color-mix(in srgb, …)`, which is how the
 * desktop derives its attention and warning tints from one status hue.
 */
fun blendOver(base: Color, top: Color, alpha: Float): Color {
    val a = alpha.coerceIn(0f, 1f)
    val inv = 1f - a
    return Color(
        red = base.red * inv + top.red * a,
        green = base.green * inv + top.green * a,
        blue = base.blue * inv + top.blue * a,
        alpha = base.alpha,
    )
}

/** [top] at [alpha] opacity, for washes that sit on an unknown surface. */
fun withAlpha(top: Color, alpha: Float): Color = top.copy(alpha = alpha.coerceIn(0f, 1f))

/**
 * The alphas the attention and warning tints use. Dark themes need a stronger
 * wash because the accent is light on a dark card; light themes need less, or the
 * card stops reading as neutral. These reproduce the Obsidian values the app
 * shipped with.
 */
private const val ATTENTION_CARD_ALPHA = 0.08f
private const val ATTENTION_BORDER_ALPHA = 0.5f
private const val ATTENTION_WASH_ALPHA = 0.2f
private const val WARNING_BANNER_ALPHA = 0.12f

/** Tints derived from a palette, for the slots Material3 does not cover. */
fun extendedColorsFor(palette: LookPalette): ExtendedColors =
    ExtendedColors(
        dark = palette.dark,
        border = palette.border,
        borderSubtle = palette.borderSubtle,
        borderFocus = palette.borderFocus,
        inputBg = palette.bgInput,
        bgHover = palette.bgHover,
        bgSelected = palette.bgSelected,
        cardBg = palette.islandBg,
        cardBgAttention = blendOver(palette.islandBg, palette.warning, ATTENTION_CARD_ALPHA),
        attentionBorder = blendOver(palette.islandBg, palette.warning, ATTENTION_BORDER_ALPHA),
        attentionBg = withAlpha(palette.warning, ATTENTION_WASH_ALPHA),
        warningBannerBg = blendOver(palette.islandBg, palette.warning, WARNING_BANNER_ALPHA),
        warningText = palette.warning,
        link = palette.link,
        success = palette.success,
        error = palette.error,
        review = palette.review,
        info = palette.info,
        textPrimary = palette.fg,
        textMuted = palette.fgMuted,
        textSubtle = palette.fgSubtle,
        diffAddBg = palette.diffAddBg,
        diffRemoveBg = palette.diffRemoveBg,
        cardRadius = palette.radiusIsland,
    )

/**
 * Material3's scheme, filled from the palette. The desktop has no Material roles,
 * so each one takes the closest variable: surfaces follow the `--bg` family,
 * status slots take the matching status hue, and the primary slot is the accent
 * the desktop uses for the active action.
 */
fun colorSchemeFor(palette: LookPalette): ColorScheme {
    val extended = extendedColorsFor(palette)
    // A quiet wash of the accent, as the desktop's hover tint.
    val accentContainer = blendOver(palette.islandBg, palette.accent, 0.16f)
    val statusContainer = blendOver(palette.islandBg, palette.error, WARNING_BANNER_ALPHA)
    val scrim = withAlpha(palette.fg, 0.32f)
    return if (palette.dark) {
        darkColorScheme(
            primary = palette.accent,
            onPrimary = palette.accentText,
            primaryContainer = accentContainer,
            onPrimaryContainer = palette.accentHover,
            secondary = palette.info,
            onSecondary = palette.bg,
            secondaryContainer = palette.bgHover,
            onSecondaryContainer = palette.fg,
            tertiary = palette.review,
            onTertiary = palette.bg,
            background = palette.bg,
            onBackground = palette.fg,
            surface = palette.panelBg,
            onSurface = palette.fg,
            surfaceVariant = palette.bgElevated,
            onSurfaceVariant = palette.fgMuted,
            surfaceContainer = palette.containerBg,
            surfaceContainerHigh = palette.bgElevated,
            outline = extended.border,
            outlineVariant = extended.borderSubtle,
            error = palette.error,
            onError = palette.accentText,
            errorContainer = statusContainer,
            onErrorContainer = palette.error,
            scrim = scrim,
        )
    } else {
        lightColorScheme(
            primary = palette.accent,
            onPrimary = palette.accentText,
            primaryContainer = accentContainer,
            onPrimaryContainer = palette.accentHover,
            secondary = palette.info,
            onSecondary = palette.bg,
            secondaryContainer = palette.bgHover,
            onSecondaryContainer = palette.fg,
            tertiary = palette.review,
            onTertiary = palette.bg,
            background = palette.bg,
            onBackground = palette.fg,
            surface = palette.panelBg,
            onSurface = palette.fg,
            surfaceVariant = palette.bgElevated,
            onSurfaceVariant = palette.fgMuted,
            surfaceContainer = palette.containerBg,
            surfaceContainerHigh = palette.bgElevated,
            outline = extended.border,
            outlineVariant = extended.borderSubtle,
            error = palette.error,
            onError = palette.accentText,
            errorContainer = statusContainer,
            onErrorContainer = palette.error,
            scrim = scrim,
        )
    }
}

/** The preset's corner radius scale, mapped onto Material3's shape slots. */
fun shapesFor(palette: LookPalette): Shapes =
    Shapes(
        extraSmall = RoundedCornerShape(palette.radiusXs),
        small = RoundedCornerShape(palette.radiusSm),
        medium = RoundedCornerShape(palette.radiusMd),
        large = RoundedCornerShape(palette.radiusLg),
        extraLarge = RoundedCornerShape(palette.radiusLg),
    )

private val LocalExtendedColors = staticCompositionLocalOf { extendedColorsFor(LookPresets.defaultForDark()) }
private val LocalLookPalette = staticCompositionLocalOf { LookPresets.defaultForDark() }

/**
 * Applies [palette] to [content].
 *
 * Callers resolve the palette from the appearance mode and the per-tone preset
 * (see [LookPresets]) rather than passing a bare light/dark flag, so a preset
 * that differs from the phone's own light/dark setting still reads correctly.
 */
@Composable
fun ParallelCodeTheme(
    palette: LookPalette,
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(
        LocalExtendedColors provides extendedColorsFor(palette),
        LocalLookPalette provides palette,
    ) {
        MaterialTheme(
            colorScheme = colorSchemeFor(palette),
            shapes = shapesFor(palette),
            content = content,
        )
    }
}

/**
 * Resolves the palette to draw with: the preset saved for the tone the phone is
 * actually in, so a light preset is never drawn in dark mode.
 */
@Composable
fun resolveLookPalette(
    darkPresetId: String?,
    lightPresetId: String?,
    darkTheme: Boolean = isSystemInDarkTheme(),
): LookPalette = LookPresets.forTone(darkTheme, if (darkTheme) darkPresetId else lightPresetId)

object AppTheme {
    /** Colors Material3 has no slot for, tinted for the active preset. */
    val extra: ExtendedColors
        @Composable @ReadOnlyComposable
        get() = LocalExtendedColors.current

    /** The active preset, for previews and anything that needs its id or radii. */
    val palette: LookPalette
        @Composable @ReadOnlyComposable
        get() = LocalLookPalette.current
}
