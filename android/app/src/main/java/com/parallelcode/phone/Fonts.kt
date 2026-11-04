package com.parallelcode.phone

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight

/**
 * The desktop's bundled faces (OFL; licenses in assets/licenses). Each file is a variable font, so
 * one file serves every weight the app asks for.
 */
object AppFonts {
    private val WEIGHTS = listOf(FontWeight.Normal, FontWeight.Medium, FontWeight.SemiBold, FontWeight.Bold)

    private fun variable(res: Int) = FontFamily(
        WEIGHTS.map { Font(res, it, variationSettings = FontVariation.Settings(FontVariation.weight(it.weight))) },
    )

    val inter = variable(R.font.inter)
    val sora = variable(R.font.sora)

    /** JetBrains Mono, the desktop's terminal and code face in every look. */
    val mono = variable(R.font.jetbrains_mono)
}

// shortcut: mirrors the --font-ui overrides in src/styles.css by hand — generate it with the
// looks if the desktop's font choices start changing often.
private val INTER_LOOKS = setOf(
    "parallel-code", "noir", "obsidian", "obsidian-light", "classic", "minimal", "islands-dark", "workbench",
)

/** The look's UI face: Inter where the desktop overrides it, else the desktop's root default, Sora. */
fun uiFontFor(palette: LookPalette): FontFamily = if (palette.id in INTER_LOOKS) AppFonts.inter else AppFonts.sora

/**
 * The look's heading face. Parallel Code sets headings in Sora; looks on the desktop's root fonts
 * use Space Grotesk, which the phone does not bundle, so they fall back to Sora as the desktop does.
 */
fun displayFontFor(palette: LookPalette): FontFamily =
    if (palette.id == LookPresets.PRESET_PARALLEL_CODE || palette.id !in INTER_LOOKS) AppFonts.sora else AppFonts.inter

/** Material3's type scale in the look's faces: headings in the display face, the rest in the UI face. */
fun typographyFor(palette: LookPalette): Typography {
    val ui = uiFontFor(palette)
    val display = displayFontFor(palette)
    fun TextStyle.ui() = copy(fontFamily = ui)
    fun TextStyle.display() = copy(fontFamily = display)
    return with(Typography()) {
        Typography(
            displayLarge = displayLarge.display(),
            displayMedium = displayMedium.display(),
            displaySmall = displaySmall.display(),
            headlineLarge = headlineLarge.display(),
            headlineMedium = headlineMedium.display(),
            headlineSmall = headlineSmall.display(),
            titleLarge = titleLarge.display(),
            titleMedium = titleMedium.display(),
            titleSmall = titleSmall.display(),
            bodyLarge = bodyLarge.ui(),
            bodyMedium = bodyMedium.ui(),
            bodySmall = bodySmall.ui(),
            labelLarge = labelLarge.ui(),
            labelMedium = labelMedium.ui(),
            labelSmall = labelSmall.ui(),
        )
    }
}
