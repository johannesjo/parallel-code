import { describe, it, expect } from 'vitest';
import { DEFAULT_BINDINGS } from '../defaults';

const APP_LAYER_IDS = [
  'app.nav.row-up',
  'app.nav.row-down',
  'app.nav.column-left',
  'app.nav.column-right',
  'app.task.reorder-left',
  'app.task.reorder-right',
  'app.task.close-shell',
  'app.task.close',
  'app.task.merge',
  'app.task.push',
  'app.task.new-shell',
  'app.task.send-prompt',
  'app.new-terminal',
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
  'term.copy',
  'term.copy-linux',
  'term.paste',
  'term.paste-linux',
  'term.shift-enter',
  'term.home',
  'term.end',
  'term.kill-line',
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

  it('platform:both bindings do not use meta without cmdOrCtrl', () => {
    const bothBindings = DEFAULT_BINDINGS.filter((b) => b.platform === 'both');
    for (const b of bothBindings) {
      if (b.modifiers.meta) {
        expect(
          b.modifiers.cmdOrCtrl,
          `${b.id} uses meta on platform:both — should use cmdOrCtrl`,
        ).toBe(true);
      }
    }
  });
});
