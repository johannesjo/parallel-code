import { describe, it, expect } from 'vitest';
import { DEFAULT_BINDINGS } from '../defaults';

const APP_LAYER_IDS = [
  'app.navigate-row-up',
  'app.navigate-row-down',
  'app.navigate-column-left',
  'app.navigate-column-right',
  'app.move-active-task-left',
  'app.move-active-task-right',
  'app.close-shell',
  'app.close-task',
  'app.merge-task',
  'app.push-task',
  'app.spawn-shell',
  'app.send-prompt',
  'app.create-terminal',
  'app.new-task',
  'app.new-task-alt',
  'app.toggle-sidebar',
  'app.toggle-help',
  'app.toggle-help-f1',
  'app.toggle-settings',
  'app.close-dialogs',
  'app.reset-zoom',
];

const TERMINAL_LAYER_IDS = [
  'terminal.copy',
  'terminal.copy-linux',
  'terminal.paste',
  'terminal.paste-linux',
  'terminal.shift-enter',
  'terminal.home',
  'terminal.end',
  'terminal.kill-line-backward',
];

describe('DEFAULT_BINDINGS', () => {
  it('contains all expected app-layer shortcuts', () => {
    const ids = new Set(DEFAULT_BINDINGS.map((b) => b.id));
    for (const id of APP_LAYER_IDS) {
      expect(ids.has(id), `Missing app-layer binding: ${id}`).toBe(true);
    }
  });

  it('contains all expected terminal-layer shortcuts', () => {
    const ids = new Set(DEFAULT_BINDINGS.map((b) => b.id));
    for (const id of TERMINAL_LAYER_IDS) {
      expect(ids.has(id), `Missing terminal-layer binding: ${id}`).toBe(true);
    }
  });

  it('has no duplicate IDs', () => {
    const ids = DEFAULT_BINDINGS.map((b) => b.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('every app-layer binding has an action', () => {
    const appBindings = DEFAULT_BINDINGS.filter((b) => b.layer === 'app');
    for (const binding of appBindings) {
      expect(binding.action, `App-layer binding "${binding.id}" is missing an action`).toBeTruthy();
    }
  });

  it('every terminal-layer binding has an action or escapeSequence', () => {
    const terminalBindings = DEFAULT_BINDINGS.filter((b) => b.layer === 'terminal');
    for (const binding of terminalBindings) {
      const hasActionOrSequence =
        (binding.action !== undefined && binding.action !== '') ||
        (binding.escapeSequence !== undefined && binding.escapeSequence !== '');
      expect(
        hasActionOrSequence,
        `Terminal-layer binding "${binding.id}" has neither action nor escapeSequence`,
      ).toBe(true);
    }
  });
});
