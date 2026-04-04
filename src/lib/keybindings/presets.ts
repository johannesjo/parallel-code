import type { Preset } from './types';

export const PRESETS: readonly Preset[] = [
  {
    id: 'default',
    name: 'Default',
    overrides: {},
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    agentId: 'claude-code',
    overrides: {
      // Unbind Option+Arrow from app layer so terminal receives Alt+B/F (word movement)
      'app.nav.column-left': null,
      'app.nav.column-right': null,
      // Move sidebar toggle from Cmd+B to Cmd+Shift+B (frees Ctrl+B for Claude's background task)
      'app.toggle-sidebar': { key: 'b', modifiers: { cmdOrCtrl: true, shift: true } },
    },
  },
];

export function getPreset(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
