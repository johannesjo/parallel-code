export type LookPreset =
  | 'parallel-code'
  | 'noir'
  | 'obsidian'
  | 'obsidian-light'
  | 'classic'
  | 'graphite'
  | 'midnight'
  | 'indigo'
  | 'ember'
  | 'glacier'
  | 'minimal'
  | 'zenburnesque'
  | 'catppuccin-mocha'
  | 'islands-dark'
  | 'islands-light'
  | 'workbench';

export type AppearanceMode = 'light' | 'dark' | 'system';

export interface LookPresetOption {
  id: LookPreset;
  label: string;
  description: string;
  tone: 'light' | 'dark';
}

export const LOOK_PRESETS: LookPresetOption[] = [
  {
    id: 'parallel-code',
    label: 'Parallel Code',
    description: 'Website-inspired blue-black surfaces, soft cyan accents, and pale text',
    tone: 'dark',
  },
  {
    id: 'noir',
    label: 'Noir',
    description: 'Ink-dark surfaces, soft lilac, and quiet controls that follow your focus',
    tone: 'dark',
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    description: 'Neutral charcoal surfaces, warm amber accent, and clean typography',
    tone: 'dark',
  },
  {
    id: 'obsidian-light',
    label: 'Obsidian Light',
    description: 'Obsidian on warm paper neutrals with a bronze accent',
    tone: 'light',
  },
  {
    id: 'islands-dark',
    label: 'Islands Dark',
    description: 'JetBrains-inspired dark panels on a tinted frame',
    tone: 'dark',
  },
  {
    id: 'islands-light',
    label: 'Islands Light',
    description: 'JetBrains-inspired light panels on a soft tinted frame',
    tone: 'light',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Flat monochrome with warm off-white accent',
    tone: 'dark',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Cool neon blue with subtle glow',
    tone: 'dark',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Graphite with pure black terminals',
    tone: 'dark',
  },
  {
    id: 'classic',
    label: 'Classic',
    description: 'Original dark utilitarian look',
    tone: 'dark',
  },
  {
    id: 'indigo',
    label: 'Indigo',
    description: 'Deep indigo base with electric violet accents',
    tone: 'dark',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm copper highlights and contrast',
    tone: 'dark',
  },
  {
    id: 'glacier',
    label: 'Glacier',
    description: 'Clean teal accents with softer depth',
    tone: 'dark',
  },
  {
    id: 'zenburnesque',
    label: 'Zenburnesque',
    description: 'Warm sage and muted earth tones',
    tone: 'dark',
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Pastel mauve accents on the cozy Catppuccin Mocha palette',
    tone: 'dark',
  },
  {
    id: 'workbench',
    label: 'Workbench',
    description: 'VS Code-inspired flat three-tier dark with cobalt blue',
    tone: 'dark',
  },
];

export function presetsForTone(tone: 'light' | 'dark'): LookPresetOption[] {
  return LOOK_PRESETS.filter((p) => p.tone === tone);
}

export function defaultPresetForTone(tone: 'light' | 'dark'): LookPreset {
  return tone === 'light' ? 'obsidian-light' : 'obsidian';
}

/** True for built-in presets with a light background; false for unknown ids. */
export function isLightPreset(id: string | undefined): boolean {
  return LOOK_PRESETS.find((p) => p.id === id)?.tone === 'light';
}

const LOOK_PRESET_IDS = new Set<string>(LOOK_PRESETS.map((p) => p.id));

export function isLookPreset(value: unknown): value is LookPreset {
  return typeof value === 'string' && LOOK_PRESET_IDS.has(value);
}
