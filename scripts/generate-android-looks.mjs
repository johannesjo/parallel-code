/**
 * Generates the phone app's look palettes from the desktop's own sources, so the
 * two never drift apart by hand:
 *
 *   src/lib/look.ts     -> preset ids, labels, descriptions and light/dark tone
 *   src/styles.css      -> the resolved colors, radii and shape scale
 *
 * The desktop assigns each `html[data-look='<id>']` rule only the variables it
 * changes; everything else falls through to `:root`. This resolves that cascade
 * per preset so the phone gets a complete palette, then writes it to
 * android/app/src/main/java/com/parallelcode/phone/LookPalettes.kt.
 *
 * Run: node scripts/generate-android-looks.mjs [--check]
 *
 * `--check` verifies the generated file is current without writing, which is how
 * LookPalettesTest keeps the two apps honest.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = join(root, 'src/styles.css');
const LOOK_TS = join(root, 'src/lib/look.ts');
const THEME_TS = join(root, 'src/lib/theme.ts');
const OUT = join(root, 'android/app/src/main/java/com/parallelcode/phone/LookPalettes.kt');

/* ------------------------------------------------------------------ CSS ---- */

/** Drops `/* ... *\/` comments while preserving line numbers for error messages. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) || []).length));
}

/**
 * Returns every rule block that declares custom properties, in source order.
 * `selectors` is the comma-split selector list, still unparsed.
 */
function ruleBlocks(css) {
  const out = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    const body = css.slice(start, i - 1);
    const props = {};
    for (const p of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      props[p[1]] = p[2].replace(/\s+/g, ' ').trim();
    }
    if (Object.keys(props).length > 0) {
      out.push({
        selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
        props,
        line: css.slice(0, m.index).split('\n').length,
      });
    }
    re.lastIndex = i;
  }
  return out;
}

/**
 * True when a selector part is *only* a look matcher, e.g.
 * `html[data-look='noir']`, `[data-look^='obsidian']` or `html:is([data-look='a'])`.
 * Structural selectors such as `html[data-look='noir'] .icon-btn` are rejected:
 * their custom properties style a specific component, not the palette.
 */
function lookMatcher(selector) {
  let s = selector.trim();
  const is = /^html:is\(([\s\S]*)\)$/.exec(s);
  if (is) {
    const parts = is[1].split(',').map((p) => p.trim());
    const matchers = parts.map(lookMatcher);
    return matchers.every(Boolean) ? (id) => matchers.some((f) => f(id)) : null;
  }
  let m = /^(?:html)?\[data-look\^='([a-z-]+)'\]$/.exec(s);
  if (m) {
    const prefix = m[1];
    return (id) => id.startsWith(prefix);
  }
  m = /^(?:html)?\[data-look='([a-z-]+)'\]$/.exec(s);
  if (m) {
    const exact = m[1];
    return (id) => id === exact;
  }
  return null;
}

function selectorMatcher(selectors) {
  const matchers = selectors.map(lookMatcher);
  if (matchers.some((f) => f === null)) return null;
  return (id) => matchers.some((f) => f(id));
}

/* --------------------------------------------------------------- colors ---- */

const HEX = /^#([0-9a-f]{6})$/i;
const HEX_SHORT = /^#([0-9a-f]{3})$/i;
const RGB = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/** Parses `#rgb`, `#rrggbb`, `rgb()` and `rgba()` into an `0xAARRGGBB` int. */
function parseColor(value) {
  const v = value.trim();
  let m = HEX.exec(v);
  if (m) return Number.parseInt(`ff${m[1]}`, 16) >>> 0;
  m = HEX_SHORT.exec(v);
  if (m) {
    const [r, g, b] = m[1].split('');
    return Number.parseInt(`ff${r}${r}${g}${g}${b}${b}`, 16) >>> 0;
  }
  m = RGB.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : Number.parseFloat(m[4]);
    const a = Math.round(alpha * 255);
    return ((a << 24) | (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3])) >>> 0;
  }
  return null;
}

const GRADIENT = /^(?:repeating-)?(?:radial|linear|conic)-gradient\(/;

/**
 * Flattens a gradient to one representative color: its middle stop, which is the
 * hue that covers most of the surface. The phone draws flat backgrounds, so a
 * gradient cannot be reproduced exactly; the middle stop is the closest single
 * color and keeps a theme's identity readable.
 */
function flatten(value) {
  const v = value.trim();
  if (!GRADIENT.test(v)) return v;
  const stops = v.slice(v.indexOf('(') + 1).match(/(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi);
  if (!stops || stops.length === 0) {
    throw new Error(`gradient with no color stops: ${value}`);
  }
  return stops[Math.floor((stops.length - 1) / 2)];
}

/** Resolves one custom property to an `0xAARRGGBB` literal body for Kotlin. */
function colorLiteral(value, where) {
  const flat = flatten(value);
  const argb = parseColor(flat);
  if (argb === null) throw new Error(`cannot parse color "${value}" (${where})`);
  const hex = argb.toString(16).padStart(8, '0');
  return `Color(0x${hex.toUpperCase()})`;
}

/* --------------------------------------------------------------- shapes ---- */

/**
 * Converts a CSS length to a Kotlin dp literal. Radii are authored in `px`,
 * which the desktop also uses as its density-independent base, so px maps 1:1
 * to dp. A unitless `0` is the one other form CSS allows for zero.
 */
function dpLiteral(value, where) {
  const m = /^(-?[\d.]+)(?:px)?$/.exec(value.trim());
  if (!m) throw new Error(`cannot parse length "${value}" (${where})`);
  const n = Number(m[1]);
  return n === 0 ? '0.dp' : `${Number(n.toFixed(2))}.dp`;
}

/* ------------------------------------------------------------ look.ts ------ */

/** Reads LOOK_PRESETS out of look.ts so ids, labels, tone and order all match. */
function readPresets(ts) {
  const start = ts.indexOf('export const LOOK_PRESETS');
  if (start < 0) throw new Error('LOOK_PRESETS not found in src/lib/look.ts');
  const end = ts.indexOf('\n];', start);
  const body = ts.slice(start, end);
  const presets = [];
  const re =
    /\{\s*id:\s*'([a-z-]+)',\s*label:\s*'([^']*)',\s*description:\s*'([^']*)',\s*tone:\s*'(light|dark)',\s*\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    presets.push({ id: m[1], label: m[2], description: m[3], tone: m[4] });
  }
  if (presets.length === 0) throw new Error('no presets parsed from src/lib/look.ts');
  return presets;
}

/* --------------------------------------------------------- terminal ANSI --- */

/**
 * The desktop's terminal themes, in the order `getTerminalTheme` checks them:
 * any light preset, then Obsidian, Noir and Islands Dark. Every other dark preset
 * falls through to xterm's own defaults, which the phone has no equivalent of, so
 * those looks reuse [TERMINAL_NOIR] (a muted dark set) rather than xterm's
 * saturated defaults. Read from src/lib/theme.ts so the four named sets match.
 */
const TERMINAL_THEMES = [
  { id: 'light', label: 'Light', theme: 'LIGHT_TERMINAL_THEME', forTone: 'light' },
  { id: 'obsidian', label: 'Obsidian', theme: 'OBSIDIAN_TERMINAL_THEME', forTone: 'dark' },
  { id: 'noir', label: 'Noir', theme: 'NOIR_TERMINAL_THEME', forTone: 'dark' },
  {
    id: 'islands-dark',
    label: 'Islands Dark',
    theme: 'ISLANDS_DARK_TERMINAL_THEME',
    forTone: 'dark',
  },
];

/**
 * A 0xAARRGGBB literal for Kotlin's `Int` fields. Hex literals above Int.MAX_VALUE
 * are Longs in Kotlin, so terminal colors (which are always opaque and so exceed
 * it) are written as signed decimals instead.
 */
const intLiteral = (argb) => String(argb > 0x7fffffff ? argb - 0x100000000 : argb);

/** The xterm ANSI slot order, matching `ansi[c]` lookups in TerminalStyle.kt. */
const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

function readTerminalThemes(ts) {
  return TERMINAL_THEMES.map(({ id, label, theme, forTone }) => {
    const match = new RegExp(`const ${theme}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as const`).exec(ts);
    if (!match) throw new Error(`${theme} not found in src/lib/theme.ts`);
    const colors = Object.fromEntries(
      [...match[1].matchAll(/(\w+):\s*'(#[0-9a-fA-F]{6})'/g)].map((m) => [m[1], m[2]]),
    );
    const argb = (name) => {
      if (!(name in colors)) throw new Error(`${theme} is missing ${name}`);
      return intLiteral(parseColor(colors[name]));
    };
    return { id, label, forTone, foreground: argb('foreground'), ansi: ANSI_SLOTS.map(argb) };
  });
}

/**
 * Which terminal theme a preset uses, following `getTerminalTheme`: light presets
 * share one set, then the three dark looks that have their own, and everything
 * else falls back to Noir.
 */
function terminalThemeIdFor(preset, byId) {
  // `preset.tone` is 'dark' | 'light' as read from look.ts.
  if (preset.tone !== 'dark') return 'light';
  const own = byId.get(preset.id);
  return own ? own.id : 'noir';
}

/* ---------------------------------------------------------------- main ----- */

const css = stripComments(readFileSync(STYLES, 'utf8'));
const presets = readPresets(readFileSync(LOOK_TS, 'utf8'));
const blocks = ruleBlocks(css);

if (!/^:root$/m.test(blocks[0].selectors[0])) {
  throw new Error(
    `expected the first custom-property block to be :root, got ${blocks[0].selectors[0]}`,
  );
}
const base = blocks[0].props;

/** Applies the cascade for one preset id. */
function resolve(presetId) {
  const vars = { ...base };
  for (const block of blocks.slice(1)) {
    const matches = selectorMatcher(block.selectors);
    if (matches && matches(presetId)) Object.assign(vars, block.props);
  }
  return vars;
}

const need = (vars, name, presetId) => {
  if (!(name in vars)) throw new Error(`preset ${presetId}: missing ${name}`);
  return vars[name];
};

/** Escapes a Kotlin string literal's body. */
const kotlinString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const terminalThemes = readTerminalThemes(readFileSync(THEME_TS, 'utf8'));
const terminalThemesById = new Map(terminalThemes.map((t) => [t.id, t]));

const entries = presets.map((preset) => {
  const v = resolve(preset.id);
  const at = (name) => colorLiteral(need(v, name, preset.id), `${preset.id} ${name}`);
  return {
    preset,
    terminalThemeId: terminalThemeIdFor(preset, terminalThemesById),
    colors: {
      bg: at('--bg'),
      bgElevated: at('--bg-elevated'),
      bgInput: at('--bg-input'),
      bgHover: at('--bg-hover'),
      bgSelected: at('--bg-selected'),
      border: at('--border'),
      borderSubtle: at('--border-subtle'),
      borderFocus: at('--border-focus'),
      fg: at('--fg'),
      fgMuted: at('--fg-muted'),
      fgSubtle: at('--fg-subtle'),
      accent: at('--accent'),
      accentHover: at('--accent-hover'),
      accentText: at('--accent-text'),
      link: at('--link'),
      success: at('--success'),
      error: at('--error'),
      warning: at('--warning'),
      review: at('--review'),
      info: at('--info'),
      islandBg: at('--island-bg'),
      islandBorder: at('--island-border'),
      containerBg: at('--task-container-bg'),
      panelBg: at('--task-panel-bg'),
      diffAddBg: at('--diff-add-bg'),
      diffRemoveBg: at('--diff-remove-bg'),
    },
    shapes: {
      radiusXs: dpLiteral(need(v, '--radius-xs', preset.id), `${preset.id} --radius-xs`),
      radiusSm: dpLiteral(need(v, '--radius-sm', preset.id), `${preset.id} --radius-sm`),
      radiusMd: dpLiteral(need(v, '--radius-md', preset.id), `${preset.id} --radius-md`),
      radiusLg: dpLiteral(need(v, '--radius-lg', preset.id), `${preset.id} --radius-lg`),
      radiusIsland: dpLiteral(
        need(v, '--island-radius', preset.id),
        `${preset.id} --island-radius`,
      ),
    },
  };
});

// Keep the field order in one place so the data class and the literals agree.
const COLOR_FIELDS = Object.keys(entries[0].colors);
const SHAPE_FIELDS = Object.keys(entries[0].shapes);

const pascal = (id) =>
  id
    .split('-')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');

function render() {
  const lines = [];
  lines.push('package com.parallelcode.phone');
  lines.push('');
  lines.push('// GENERATED FILE - DO NOT EDIT.');
  lines.push('//');
  lines.push('// Regenerate with: node scripts/generate-android-looks.mjs');
  lines.push('// Source of truth: src/lib/look.ts (ids, labels, descriptions, tone) and');
  lines.push('// src/styles.css (colors and radii), matching the desktop app.');
  lines.push('//');
  lines.push('// The desktop themes set only the variables they change and inherit the rest');
  lines.push('// from :root; every palette below is that cascade fully resolved, so the phone');
  lines.push('// has no fallbacks of its own. Gradients are flattened to their middle stop');
  lines.push('// because the phone draws flat surfaces; everything else is the exact value.');
  lines.push('');
  lines.push('import androidx.compose.runtime.Immutable');
  lines.push('import androidx.compose.ui.graphics.Color');
  lines.push('import androidx.compose.ui.unit.Dp');
  lines.push('import androidx.compose.ui.unit.dp');
  lines.push('');

  lines.push('/**');
  lines.push(' * One desktop look preset: every color and radius the phone draws with.');
  lines.push(' *');
  lines.push(' * Read these through [LookPresets] rather than constructing one.');
  lines.push(' */');
  lines.push('@Immutable');
  lines.push('data class LookPalette(');
  lines.push('    val id: String,');
  lines.push('    val label: String,');
  lines.push('    val description: String,');
  lines.push("    /** True for the desktop's light presets. */");
  lines.push('    val dark: Boolean,');
  lines.push("    // Surfaces and state, from the desktop's --bg family.");
  lines.push('    val bg: Color,');
  lines.push('    val bgElevated: Color,');
  lines.push('    val bgInput: Color,');
  lines.push('    val bgHover: Color,');
  lines.push('    val bgSelected: Color,');
  lines.push('    // Borders.');
  lines.push('    val border: Color,');
  lines.push('    val borderSubtle: Color,');
  lines.push('    val borderFocus: Color,');
  lines.push('    // Text.');
  lines.push('    val fg: Color,');
  lines.push('    val fgMuted: Color,');
  lines.push('    val fgSubtle: Color,');
  lines.push('    // Accent family.');
  lines.push('    val accent: Color,');
  lines.push('    val accentHover: Color,');
  lines.push('    val accentText: Color,');
  lines.push('    val link: Color,');
  lines.push('    // Status hues: success, error and warning plus the secondary');
  lines.push('    // review and info hues the desktop keeps off the accent.');
  lines.push('    val success: Color,');
  lines.push('    val error: Color,');
  lines.push('    val warning: Color,');
  lines.push('    val review: Color,');
  lines.push('    val info: Color,');
  lines.push('    // Panels.');
  lines.push('    val islandBg: Color,');
  lines.push('    val islandBorder: Color,');
  lines.push('    val containerBg: Color,');
  lines.push('    val panelBg: Color,');
  lines.push('    // Diff line tints.');
  lines.push('    val diffAddBg: Color,');
  lines.push('    val diffRemoveBg: Color,');
  lines.push("    // The desktop's corner radius scale, in dp.");
  lines.push('    val radiusXs: Dp,');
  lines.push('    val radiusSm: Dp,');
  lines.push('    val radiusMd: Dp,');
  lines.push('    val radiusLg: Dp,');
  lines.push('    /** Corner radius of an island or card, `--island-radius`. */');
  lines.push('    val radiusIsland: Dp,');
  lines.push('    /**');
  lines.push('     * Id of the [TERMINAL_THEMES] entry this look draws terminals with, so agent');
  lines.push('     * output follows the look the way it does on the desktop.');
  lines.push('     */');
  lines.push('    val terminalThemeId: String,');
  lines.push(')');
  lines.push('');

  lines.push('/**');
  lines.push(" * One of the desktop's terminal color sets: a default text color and the 16 ANSI");
  lines.push(' * colors, in the order `ansi[c]` is indexed in TerminalStyle.kt.');
  lines.push(' */');
  lines.push('@Immutable');
  lines.push('data class TerminalTheme(');
  lines.push('    val id: String,');
  lines.push('    val foreground: Int,');
  lines.push('    val ansi: List<Int>,');
  lines.push(')');
  lines.push('');

  for (const theme of terminalThemes) {
    lines.push(`private val Terminal${pascal(theme.id)} =`);
    lines.push('    TerminalTheme(');
    lines.push(`        id = ${kotlinString(theme.id)},`);
    lines.push(`        foreground = ${theme.foreground},`);
    lines.push('        ansi =');
    lines.push('            listOf(');
    for (const color of theme.ansi) lines.push(`                ${color},`);
    lines.push('            ),');
    lines.push('    )');
    lines.push('');
  }

  lines.push('/** Every terminal theme, by id. */');
  lines.push('val ALL_TERMINAL_THEMES: Map<String, TerminalTheme> =');
  lines.push('    listOf(');
  for (const theme of terminalThemes) lines.push(`        Terminal${pascal(theme.id)},`);
  lines.push('    ).associateBy { it.id }');
  lines.push('');

  for (const { preset, terminalThemeId, colors, shapes } of entries) {
    lines.push(`private val ${pascal(preset.id)} =`);
    lines.push('    LookPalette(');
    lines.push(`        id = ${kotlinString(preset.id)},`);
    lines.push(`        label = ${kotlinString(preset.label)},`);
    lines.push(`        description = ${kotlinString(preset.description)},`);
    lines.push(`        dark = ${preset.tone === 'dark'},`);
    for (const f of COLOR_FIELDS) lines.push(`        ${f} = ${colors[f]},`);
    for (const f of SHAPE_FIELDS) lines.push(`        ${f} = ${shapes[f]},`);
    lines.push(`        terminalThemeId = ${kotlinString(terminalThemeId)},`);
    lines.push('    )');
    lines.push('');
  }

  lines.push('/** Every preset, in the order the desktop lists them. */');
  lines.push('val ALL_LOOK_PALETTES: List<LookPalette> =');
  lines.push('    listOf(');
  for (const { preset } of entries) lines.push(`        ${pascal(preset.id)},`);
  lines.push('    )');
  lines.push('');

  return lines.join('\n');
}

const generated = render();
const relativeOut = OUT.slice(root.length + 1);
const regenerate = 'Run: npm run generate:android-looks';

if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error(`${relativeOut} is missing. ${regenerate}`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(
      `${relativeOut} is out of date with src/lib/look.ts and src/styles.css.\n${regenerate}`,
    );
    process.exit(1);
  }
  console.log(`${relativeOut} is up to date (${entries.length} presets).`);
} else {
  writeFileSync(OUT, generated);
  console.log(`Wrote ${relativeOut} (${entries.length} presets).`);
}
