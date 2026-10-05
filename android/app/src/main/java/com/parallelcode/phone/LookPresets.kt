package com.parallelcode.phone

/**
 * Lookups over the generated [ALL_LOOK_PALETTES], mirroring the desktop's
 * `presetsForTone`, `defaultPresetForTone` and `isLookPreset` in src/lib/look.ts.
 *
 * The palette list itself is generated from the desktop, so ids, labels and
 * light/dark tone are identical on both apps and no id is ever unknown here.
 */
object LookPresets {

    /**
     * Placeholder fallback for the two default lookups, which would otherwise
     * recurse through [byId]'s default argument. A generated palette always
     * contains both Obsidian ids and LookPalettesTest asserts it, so reaching
     * this would mean the generated file is broken; the caller still gets a
     * usable value instead of a throw.
     */
    private val MISSING: LookPalette = ALL_LOOK_PALETTES.first()

    /** Dark presets, in the order the desktop lists them. */
    val dark: List<LookPalette> = ALL_LOOK_PALETTES.filter { it.dark }

    /** Light presets, in the order the desktop lists them. */
    val light: List<LookPalette> = ALL_LOOK_PALETTES.filter { !it.dark }

    /** Every preset, in the order the desktop lists them. */
    val all: List<LookPalette> = ALL_LOOK_PALETTES

    /**
     * The desktop's default for a tone, and this app's: Obsidian in both light
     * and dark, matching `defaultPresetForTone` on the desktop.
     *
     * [byId] defaults to the dark default, so the light default passes its own
     * fallback rather than relying on that.
     */
    fun defaultForDark(): LookPalette = byId(PRESET_OBSIDIAN, MISSING)

    fun defaultForLight(): LookPalette = byId(PRESET_OBSIDIAN_LIGHT, MISSING)

    fun defaultFor(dark: Boolean): LookPalette = if (dark) defaultForDark() else defaultForLight()

    /**
     * The palette for [id] as long as it suits [dark]; otherwise the default for
     * that tone. This is the one place that resolves a stored id, and it enforces
     * the invariant a light preset is never drawn in dark mode. Settings can hold
     * a mismatched id (hand-edited preferences, a preset removed upstream), so
     * every read goes through here.
     */
    fun forTone(dark: Boolean, id: String?): LookPalette {
        val preset = byId(id, defaultFor(dark))
        return if (preset.dark == dark) preset else defaultFor(dark)
    }

    /**
     * The palette for [id], or [fallback] when the id is missing or unknown.
     * Settings stored by an older build can name a preset that no longer exists,
     * so callers resolve through here rather than indexing directly.
     */
    fun byId(id: String?, fallback: LookPalette = defaultForDark()): LookPalette =
        ALL_LOOK_PALETTES.firstOrNull { it.id == id } ?: fallback

    /** True when [id] names a preset this build knows. */
    fun isKnown(id: String?): Boolean = id != null && ALL_LOOK_PALETTES.any { it.id == id }

    const val PRESET_OBSIDIAN = "obsidian"
    const val PRESET_OBSIDIAN_LIGHT = "obsidian-light"
}
