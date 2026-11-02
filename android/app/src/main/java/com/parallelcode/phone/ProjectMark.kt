package com.parallelcode.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The project's mark, as the desktop's ProjectSwatch draws it: its icon in the project color, or
 * a small rounded square when it has no icon. A square, not a dot, because dots are task status.
 */
@Composable
fun ProjectMark(color: Color, icon: String?, modifier: Modifier = Modifier) {
    val vector = remember(icon) { icon?.let(::projectIconVector) }
    if (vector != null) {
        // A glyph at the square's size is unreadable, so the icon is drawn a little larger.
        Icon(vector, contentDescription = null, tint = color, modifier = modifier.size(12.dp))
    } else {
        Box(modifier.size(8.dp).background(color, RoundedCornerShape(2.dp)))
    }
}

/** The desktop icon [id] as a vector, or null for an id this build does not know. */
private fun projectIconVector(id: String): ImageVector? {
    val paths = PROJECT_ICON_PATHS[id] ?: return null
    return ImageVector.Builder(
        name = "project-$id",
        defaultWidth = 16.dp,
        defaultHeight = 16.dp,
        viewportWidth = 16f,
        viewportHeight = 16f,
    ).apply {
        paths.forEach { addPath(addPathNodes(it), fill = SolidColor(Color.Black)) }
    }.build()
}

/**
 * Parses the project colors the desktop stores: `#rgb`, `#rrggbb` and `hsl(h, s%, l%)` (commas
 * optional). Null for anything else, so the caller can fall back to a neutral color.
 */
fun parseCssColor(css: String?): Color? {
    val value = css?.trim()?.lowercase() ?: return null
    if (value.startsWith("#")) {
        val hex = value.drop(1)
        val full = when (hex.length) {
            3 -> hex.map { "$it$it" }.joinToString("")
            6 -> hex
            else -> return null
        }
        val rgb = full.toLongOrNull(16) ?: return null
        return Color(0xFF000000 or rgb)
    }
    val hsl = Regex("""^hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$""").find(value)
        ?: return null
    // The pattern admits "1.2.3", which is no number; skip it rather than crash.
    val (h, s, l) = hsl.destructured.toList().map { it.toFloatOrNull() ?: return null }
    return Color.hsl(h % 360f, (s / 100f).coerceIn(0f, 1f), (l / 100f).coerceIn(0f, 1f))
}
