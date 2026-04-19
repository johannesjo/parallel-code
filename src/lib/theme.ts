import type { LookPreset } from './look';

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

  // Island containers (task columns, sidebar)
  islandBg: 'var(--island-bg)',
  islandBorder: 'var(--island-border)',
  islandRadius: 'var(--island-radius)',
  taskContainerBg: 'var(--task-container-bg)',
  taskPanelBg: 'var(--task-panel-bg)',
} as const;

/** Opaque terminal background per preset — matches --task-panel-bg */
const terminalBackground: Record<LookPreset, string> = {
  classic: '#2d2e32',
  graphite: '#1c2630',
  midnight: '#000000',
  indigo: '#1c2038',
  ember: '#211918',
  glacier: '#232e3a',
  minimal: '#262626',
  zenburnesque: '#2e2d2a',
};

/** Returns an xterm-compatible theme object for the given preset */
export function getTerminalTheme(preset: LookPreset) {
  return {
    background: terminalBackground[preset],
  };
}

/** Generates a styled banner (warning/error/info) using color-mix for background+border. */
export function bannerStyle(color: string): Record<string, string> {
  return {
    color,
    background: `color-mix(in srgb, ${color} 8%, transparent)`,
    padding: '8px 12px',
    'border-radius': '8px',
    border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
  };
}

/** Shared style for uppercase section label headings in dialogs. */
export const sectionLabelStyle: Record<string, string> = {
  'font-size': '12px',
  color: 'var(--fg-muted)',
  'text-transform': 'uppercase',
  'letter-spacing': '0.05em',
};
