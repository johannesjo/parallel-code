import * as monaco from 'monaco-editor';
import type { LookPreset } from './look';

interface PresetColors {
  bgElevated: string;
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  border: string;
  accent: string;
}

// Colors must match the CSS variables in src/styles.css for the warp theme.
// Diff highlight colors use the GitHub Dark palette.
const presetColors: Record<LookPreset, PresetColors> = {
  warp: {
    bgElevated: '#1a1a1e',
    fg: '#e4e4e8',
    fgMuted: '#9b9ba4',
    fgSubtle: '#5c5c66',
    border: '#2a2a2e',
    accent: '#6e56cf',
  },
};

function buildThemeData(c: PresetColors): monaco.editor.IStandaloneThemeData {
  return {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: c.fgSubtle.slice(1) },
      { token: 'keyword', foreground: c.accent.slice(1) },
    ],
    colors: {
      'editor.background': c.bgElevated,
      'editor.foreground': c.fg,
      'editor.lineHighlightBackground': '#ffffff06',
      'editorLineNumber.foreground': c.fgSubtle,
      'editorLineNumber.activeForeground': c.fgMuted,
      'editor.selectionBackground': c.accent + '33',
      'editorWidget.background': c.bgElevated,
      'editorWidget.border': c.border,
      // GitHub-inspired diff palette, toned down for dark backgrounds
      'diffEditor.insertedLineBackground': '#2ea04315',
      'diffEditor.removedLineBackground': '#f8514915',
      'diffEditor.insertedTextBackground': '#2ea04340',
      'diffEditor.removedTextBackground': '#f8514940',
      'diffEditorGutter.insertedLineBackground': '#2ea04326',
      'diffEditorGutter.removedLineBackground': '#f8514926',
      'diffEditor.unchangedRegionBackground': c.border,
      'diffEditor.unchangedRegionForeground': c.fgMuted,
      'diffEditor.unchangedRegionShadow': '#00000000',
      'scrollbarSlider.background': c.fgSubtle + '40',
      'scrollbarSlider.hoverBackground': c.fgSubtle + '60',
    },
  };
}

export function monacoThemeName(preset: LookPreset): string {
  return `parallel-${preset}`;
}

export function registerMonacoThemes(): void {
  for (const [preset, colors] of Object.entries(presetColors)) {
    monaco.editor.defineTheme(monacoThemeName(preset as LookPreset), buildThemeData(colors));
  }
}
