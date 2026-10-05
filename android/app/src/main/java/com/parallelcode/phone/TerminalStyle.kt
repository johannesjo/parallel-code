package com.parallelcode.phone

import androidx.compose.ui.graphics.Color

/**
 * A cell's SGR state packed into a Long so the screen stores one primitive per cell.
 * Bits 0–25: foreground, 26–51: background, 52+: flags. A color is [DEFAULT_COLOR], a palette
 * index (0–255), or [RGB_FLAG] plus a 24-bit RGB value.
 */
object CellStyle {
    const val DEFAULT_COLOR = 0x3FFFFFF
    const val RGB_FLAG = 0x1000000
    private const val COLOR_BITS = 26
    private const val FLAG_SHIFT = 52

    const val BOLD = 1
    const val DIM = 2
    const val ITALIC = 4
    const val UNDERLINE = 8
    const val INVERSE = 16
    const val STRIKE = 32
    const val HIDDEN = 64

    const val DEFAULT: Long = DEFAULT_COLOR.toLong() or (DEFAULT_COLOR.toLong() shl COLOR_BITS)

    fun fg(style: Long): Int = (style and DEFAULT_COLOR.toLong()).toInt()
    fun bg(style: Long): Int = ((style shr COLOR_BITS) and DEFAULT_COLOR.toLong()).toInt()
    fun flags(style: Long): Int = (style ushr FLAG_SHIFT).toInt()

    fun of(fg: Int, bg: Int, flags: Int): Long =
        fg.toLong() or (bg.toLong() shl COLOR_BITS) or (flags.toLong() shl FLAG_SHIFT)

    /** Erased cells keep only the background, as xterm does. */
    fun eraseStyle(style: Long): Long = of(DEFAULT_COLOR, bg(style), 0)

    /** Apply one `CSI … m` body, in both `;` and `:` sub-parameter forms. */
    fun applySgr(style: Long, body: String): Long {
        var fg = fg(style)
        var bg = bg(style)
        var flags = flags(style)
        val groups = body.split(';')
        var i = 0
        while (i < groups.size) {
            val group = groups[i]
            if (':' in group) {
                val sub = group.split(':').map { it.toIntOrNull() }
                when (sub[0]) {
                    38 -> extendedColor(sub.drop(1))?.let { fg = it }
                    48 -> extendedColor(sub.drop(1))?.let { bg = it }
                    4 -> flags = if (sub.getOrNull(1) == 0) flags and UNDERLINE.inv() else flags or UNDERLINE
                }
                i++
                continue
            }
            val code = group.toIntOrNull() ?: 0
            if (code == 38 || code == 48) {
                // `38;5;n` or `38;2;r;g;b`
                val mode = groups.getOrNull(i + 1)?.toIntOrNull()
                val argCount = when (mode) {
                    5 -> 1
                    2 -> 3
                    else -> 0
                }
                val args = groups.subList(minOf(i + 1, groups.size), minOf(i + 2 + argCount, groups.size))
                    .map { it.toIntOrNull() }
                extendedColor(args)?.let { if (code == 38) fg = it else bg = it }
                i += 2 + argCount
                continue
            }
            when (code) {
                0 -> {
                    fg = DEFAULT_COLOR
                    bg = DEFAULT_COLOR
                    flags = 0
                }
                1 -> flags = flags or BOLD
                2 -> flags = flags or DIM
                3 -> flags = flags or ITALIC
                4 -> flags = flags or UNDERLINE
                7 -> flags = flags or INVERSE
                8 -> flags = flags or HIDDEN
                9 -> flags = flags or STRIKE
                21, 22 -> flags = flags and (BOLD or DIM).inv()
                23 -> flags = flags and ITALIC.inv()
                24 -> flags = flags and UNDERLINE.inv()
                27 -> flags = flags and INVERSE.inv()
                28 -> flags = flags and HIDDEN.inv()
                29 -> flags = flags and STRIKE.inv()
                in 30..37 -> fg = code - 30
                39 -> fg = DEFAULT_COLOR
                in 40..47 -> bg = code - 40
                49 -> bg = DEFAULT_COLOR
                in 90..97 -> fg = code - 90 + 8
                in 100..107 -> bg = code - 100 + 8
            }
            i++
        }
        return of(fg, bg, flags)
    }

    /** `[5, n]` or `[2, r, g, b]`; the colon form may put a color-space id before r, g, b. */
    private fun extendedColor(args: List<Int?>): Int? = when (args.getOrNull(0)) {
        5 -> args.getOrNull(1)?.takeIf { it in 0..255 }
        2 -> {
            val rgb = (if (args.size >= 5) args.takeLast(3) else args.drop(1))
                .filterNotNull()
                .filter { it in 0..255 }
            if (rgb.size == 3) RGB_FLAG or (rgb[0] shl 16) or (rgb[1] shl 8) or rgb[2] else null
        }
        else -> null
    }
}

/** Colors for one span, as ARGB. `background` is null where the terminal background shows. */
data class ResolvedStyle(
    val foreground: Int,
    val background: Int?,
    val bold: Boolean,
    val italic: Boolean,
    val underline: Boolean,
    val strike: Boolean,
)

/**
 * A terminal's colors: the default text color, its background, and the 16 ANSI
 * colors. The background is the look's own panel color, and the ANSI set is the
 * one the desktop pairs with that look (see the generated [TerminalTheme]s).
 */
class TerminalPalette(
    val foreground: Int,
    val background: Int,
    private val ansi: IntArray,
) {
    fun resolve(style: Long): ResolvedStyle {
        val flags = CellStyle.flags(style)
        val bold = flags and CellStyle.BOLD != 0
        var fg = CellStyle.fg(style).let { c ->
            when {
                c == CellStyle.DEFAULT_COLOR -> foreground
                // Like xterm.js, bold text in the first eight colors uses their bright variant.
                bold && c < 8 -> ansi[c + 8]
                else -> color(c)
            }
        }
        var bg = CellStyle.bg(style).takeIf { it != CellStyle.DEFAULT_COLOR }?.let(::color)
        if (flags and CellStyle.INVERSE != 0) {
            val swapped = bg ?: background
            bg = fg
            fg = swapped
        }
        if (flags and CellStyle.DIM != 0) fg = (fg and 0xFFFFFF) or (0x80 shl 24)
        if (flags and CellStyle.HIDDEN != 0) fg = bg ?: background
        return ResolvedStyle(
            foreground = fg,
            background = bg,
            bold = bold,
            italic = flags and CellStyle.ITALIC != 0,
            underline = flags and CellStyle.UNDERLINE != 0,
            strike = flags and CellStyle.STRIKE != 0,
        )
    }

    private fun color(c: Int): Int = OPAQUE or when {
        c and CellStyle.RGB_FLAG != 0 -> c and 0xFFFFFF
        c < 16 -> ansi[c]
        c < 232 -> {
            val i = c - 16
            (CUBE[i / 36] shl 16) or (CUBE[i / 6 % 6] shl 8) or CUBE[i % 6]
        }
        else -> (8 + (c - 232) * 10).let { (it shl 16) or (it shl 8) or it }
    }

    companion object {
        private const val OPAQUE = 0xFF shl 24
        private val CUBE = intArrayOf(0, 95, 135, 175, 215, 255)

        /**
         * The terminal palette for [palette], pairing its generated ANSI set with
         * its own panel background, which is what the desktop does per look.
         */
        fun forLook(palette: LookPalette): TerminalPalette {
            val theme = ALL_TERMINAL_THEMES[palette.terminalThemeId] ?: error("no terminal theme ${palette.terminalThemeId}")
            return TerminalPalette(
                foreground = OPAQUE or theme.foreground,
                background = OPAQUE or palette.panelBg.toArgbInt(),
                ansi = IntArray(16) { OPAQUE or theme.ansi[it] },
            )
        }

        /** A [Color]'s 0xAARRGGBB int; the terminal palettes store colors this way. */
        private fun Color.toArgbInt(): Int =
            ((alpha * 255).toInt() shl 24) or
                ((red * 255).toInt() shl 16) or
                ((green * 255).toInt() shl 8) or
                (blue * 255).toInt()
    }
}
