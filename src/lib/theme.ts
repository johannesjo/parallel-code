import { colord } from 'colord';
import { isLightPreset } from './look';
import type { LookPreset } from './look';
import { CSS_VARS } from './custom-theme';
import type { CssVar } from './custom-theme';

/** Theme tokens referencing CSS variables defined in styles.css */
export const theme = {
  // Backgrounds (3-tier: black → task columns → panels inside)
  bg: 'var(--bg)',
  bgElevated: 'var(--bg-elevated)',
  bgInput: 'var(--bg-input)',
  bgHover: 'var(--bg-hover)',
  bgSelected: 'var(--bg-selected)',
  bgSelectedSubtle: 'var(--bg-selected-subtle)',

  // Borders
  border: 'var(--border)',
  borderSubtle: 'var(--border-subtle)',
  borderFocus: 'var(--border-focus)',

  // Text
  fg: 'var(--fg)',
  fgMuted: 'var(--fg-muted)',
  fgSubtle: 'var(--fg-subtle)',

  // Accent
  accent: 'var(--accent)',
  accentHover: 'var(--accent-hover)',
  accentText: 'var(--accent-text)',
  link: 'var(--link)',

  // Semantic
  success: 'var(--success)',
  error: 'var(--error)',
  warning: 'var(--warning)',
  review: 'var(--review)',
  info: 'var(--info)',

  // Island containers (task columns, sidebar)
  islandBg: 'var(--island-bg)',
  islandBorder: 'var(--island-border)',
  islandRadius: 'var(--island-radius)',
  taskContainerBg: 'var(--task-container-bg)',
  taskPanelBg: 'var(--task-panel-bg)',

  diffAddBg: 'var(--diff-add-bg)',
  diffRemoveBg: 'var(--diff-remove-bg)',
  searchMatch: 'var(--search-match)',
  searchMatchActive: 'var(--search-match-active)',
} as const;

// GitHub-light-ish xterm palette (text, cursor, selection + 16 ANSI colors)
// for light terminal backgrounds, so colored output (claude prompts,
// ls --color, git status) stays legible on white. Shared by the built-in
// light presets and any custom theme with a light background.
export const LIGHT_TERMINAL_THEME = {
  foreground: '#1f2329',
  cursor: '#1f2329',
  cursorAccent: '#ffffff',
  selectionBackground: '#cfe1ff',
  black: '#24292e',
  red: '#cf222e',
  green: '#116329',
  yellow: '#8a6d00',
  blue: '#0550ae',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#0969da',
  brightMagenta: '#6639ba',
  brightCyan: '#3192aa',
  brightWhite: '#1f2329',
} as const;

// Obsidian's muted pastels carried into ANSI, so agent and shell output
// matches the UI instead of xterm's saturated defaults. Bright black stays
// at AA contrast because CLIs use it for secondary text.
const OBSIDIAN_TERMINAL_THEME = {
  foreground: '#e4e4e4',
  cursor: '#c4a77d',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#4a4339',
  black: '#2e2e2e',
  red: '#e08c96',
  green: '#98c9ae',
  yellow: '#dfc18e',
  blue: '#8fb3dc',
  magenta: '#c1b0e8',
  cyan: '#8ec9c9',
  white: '#c9c9c9',
  brightBlack: '#858585',
  brightRed: '#eaa0aa',
  brightGreen: '#addcc1',
  brightYellow: '#ead3a8',
  brightBlue: '#a8c5e8',
  brightMagenta: '#d2c4f0',
  brightCyan: '#a6dada',
  brightWhite: '#ededed',
} as const;

// Islands Dark carries its cool blue accent and semantic colors into ANSI.
// Keep bright black readable because terminal programs use it for muted text.
const ISLANDS_DARK_TERMINAL_THEME = {
  foreground: '#bcbec4',
  cursor: '#6d9df8',
  cursorAccent: '#181a1d',
  selectionBackground: '#28416c',
  black: '#30343a',
  red: '#f75464',
  green: '#6aab73',
  yellow: '#e8a33e',
  blue: '#6d9df8',
  magenta: '#bd9ae8',
  cyan: '#70b9c7',
  white: '#bcbec4',
  brightBlack: '#8a8d94',
  brightRed: '#ff7885',
  brightGreen: '#87c58e',
  brightYellow: '#f4be69',
  brightBlue: '#92b7ff',
  brightMagenta: '#d1b1f3',
  brightCyan: '#91d2dc',
  brightWhite: '#eef0f4',
} as const;

// Noir's cool, violet-tinted neutrals and semantic colors carried into ANSI.
// Magenta leans pink so agent output never reads as the lilac focus accent.
const NOIR_TERMINAL_THEME = {
  foreground: '#e8e8ef',
  cursor: '#b7a5f5',
  cursorAccent: '#15151b',
  selectionBackground: '#393247',
  black: '#3b3a48',
  red: '#f08f8a',
  green: '#98c9ae',
  yellow: '#dfba83',
  blue: '#8fbddd',
  magenta: '#e3a3d6',
  cyan: '#8ccfd0',
  white: '#c4c3d0',
  brightBlack: '#90909e',
  brightRed: '#f5a8a4',
  brightGreen: '#addcc1',
  brightYellow: '#ead0a5',
  brightBlue: '#a9cdea',
  brightMagenta: '#eebde5',
  brightCyan: '#a6dcdc',
  brightWhite: '#f2f2f7',
} as const;

// Website cyan with muted ANSI colors on its blue-black workspace surface.
const PARALLEL_CODE_TERMINAL_THEME = {
  foreground: '#f0f4f7',
  cursor: '#67d9ed',
  cursorAccent: '#080c10',
  selectionBackground: '#18343e',
  black: '#29343d',
  red: '#f08f8a',
  green: '#98c9ae',
  yellow: '#dfba83',
  blue: '#8fbddd',
  magenta: '#c1b0e8',
  cyan: '#67d9ed',
  white: '#c4d0d9',
  brightBlack: '#8193a2',
  brightRed: '#f5a8a4',
  brightGreen: '#addcc1',
  brightYellow: '#ead0a5',
  brightBlue: '#a9cdea',
  brightMagenta: '#d2c4f0',
  brightCyan: '#91e5f3',
  brightWhite: '#f0f4f7',
} as const;

/**
 * Returns an xterm-compatible theme object for the given preset.
 * For light-background presets we override xterm's defaults (white text,
 * white-ish bright ANSI palette) so plain output stays readable.
 */
export function getTerminalTheme(preset: LookPreset) {
  const background = readCssVarsForPreset(preset)['--task-panel-bg'] ?? '#000000';
  if (preset === 'parallel-code') {
    return { background, ...PARALLEL_CODE_TERMINAL_THEME };
  }
  if (isLightPreset(preset)) {
    return { background, ...LIGHT_TERMINAL_THEME };
  }
  if (preset === 'obsidian') {
    return { background, ...OBSIDIAN_TERMINAL_THEME };
  }
  if (preset === 'noir') {
    return { background, ...NOIR_TERMINAL_THEME };
  }
  if (preset === 'islands-dark') {
    return { background, ...ISLANDS_DARK_TERMINAL_THEME };
  }
  return { background };
}

/**
 * Reads all CSS custom property values for a built-in preset by temporarily
 * switching data-look on the root element. No repaint occurs between the switch
 * and restore since getComputedStyle is synchronous within a single JS task.
 */
export function readCssVarsForPreset(presetId: string): Partial<Record<CssVar, string>> {
  const el = document.documentElement;
  const savedLook = el.dataset.look;
  const savedCustomTheme = el.dataset.customTheme;
  // Suppress the active custom-theme overlay so computed vars come from the
  // built-in preset alone, not from any custom stylesheet on top of it.
  const styleEl = document.getElementById('custom-theme-style') as HTMLStyleElement | null;
  const savedStyleContent = styleEl?.textContent ?? null;

  el.dataset.look = presetId;
  delete el.dataset.customTheme;
  if (styleEl) styleEl.textContent = '';

  const style = getComputedStyle(el);
  const result: Partial<Record<CssVar, string>> = {};
  for (const v of CSS_VARS) {
    const val = style.getPropertyValue(v).trim();
    if (val) result[v as CssVar] = val;
  }

  if (savedLook !== undefined) {
    el.dataset.look = savedLook;
  } else {
    delete el.dataset.look;
  }
  if (savedCustomTheme !== undefined) {
    el.dataset.customTheme = savedCustomTheme;
  }
  if (styleEl && savedStyleContent !== null) styleEl.textContent = savedStyleContent;

  return result;
}

/** Returns an xterm-compatible theme object for a custom theme. */
export function getTerminalThemeForCustom(bg: string) {
  const isLight = (() => {
    try {
      return colord(bg).luminance() > 0.5;
    } catch {
      return false;
    }
  })();

  if (isLight) {
    return { background: bg, ...LIGHT_TERMINAL_THEME };
  }
  return { background: bg };
}

export function getTerminalSearchDecorations() {
  const style = getComputedStyle(document.documentElement);
  const rawMatch = style.getPropertyValue('--search-match').trim();
  const rawActive = style.getPropertyValue('--search-match-active').trim();
  const match = colord(rawMatch).isValid() ? rawMatch : '#ffd54f';
  const active = colord(rawActive).isValid() ? rawActive : '#ff8a00';

  return {
    matchBackground: colord(match).alpha(0.4).toRgbString(),
    matchOverviewRuler: match,
    activeMatchBackground: colord(active).alpha(0.85).toRgbString(),
    activeMatchColorOverviewRuler: active,
  } as const;
}

/** Generates a styled banner (warning/error/info) using color-mix for background+border. */
export function bannerStyle(color: string): Record<string, string> {
  return {
    color,
    background: `color-mix(in srgb, ${color} 8%, transparent)`,
    padding: '8px 12px',
    'border-radius': 'var(--radius-md)',
    border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
  };
}

/** A secondary choice that reads as text, e.g. switching how a dialog acts. */
export const linkButtonStyle: Record<string, string> = {
  background: 'none',
  border: 'none',
  padding: '0',
  color: theme.fgMuted,
  'text-decoration': 'underline',
  cursor: 'pointer',
  'font-size': '12px',
};

/** Inline style for dialog footer buttons; pair with the btn-primary/btn-secondary class. */
export function dialogButtonStyle(primary: boolean, disabled = false): Record<string, string> {
  return {
    padding: '9px 18px',
    background: primary ? theme.accent : theme.bgInput,
    border: primary ? 'none' : `1px solid ${theme.border}`,
    'border-radius': 'var(--radius-md)',
    color: primary ? theme.accentText : theme.fgMuted,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? '0.5' : '1',
    'font-size': '14px',
    'font-weight': primary ? '500' : '400',
  };
}

/** Shared style for uppercase section label headings in dialogs. */
export const sectionLabelStyle: Record<string, string> = {
  'font-size': '12px',
  color: 'var(--fg-muted)',
  'text-transform': 'uppercase',
  'letter-spacing': '0.05em',
};
