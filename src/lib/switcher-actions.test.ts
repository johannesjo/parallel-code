import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BINDINGS } from './keybindings/defaults';
import type { KeyBinding } from './keybindings/types';
import {
  ACTION_INFO,
  loadRecentActions,
  orderByRecency,
  rememberAction,
  switcherActions,
  type ActionContext,
} from './switcher-actions';

function binding(overrides: Partial<KeyBinding>): KeyBinding {
  return {
    id: overrides.action ?? 'x',
    layer: 'app',
    category: 'App',
    description: 'Something',
    platform: 'both',
    key: 'b',
    modifiers: { ctrl: true },
    ...overrides,
  };
}

const onTask: ActionContext = { activeName: 'Fix login', taskActive: true, documentOpen: false };
const nothing: ActionContext = { activeName: null, taskActive: false, documentOpen: false };

describe('switcherActions', () => {
  it('lists each app action once, named by its first binding, with its shortcut', () => {
    const actions = switcherActions(
      [
        binding({ action: 'toggleSidebar', description: 'Toggle sidebar' }),
        binding({ action: 'newTask', description: 'New task', unbound: true }),
        binding({ action: 'newTask', description: 'New task (alternate shortcut)', key: 'n' }),
      ],
      nothing,
    );
    expect(actions.map((a) => [a.id, a.name, a.shortcut])).toEqual([
      ['toggleSidebar', 'Toggle sidebar', 'Ctrl + B'],
      ['newTask', 'New task', 'Ctrl + N'],
    ]);
  });

  it('keeps unbound actions runnable, without a shortcut', () => {
    const [action] = switcherActions([binding({ action: 'zoomIn', unbound: true })], nothing);
    expect(action?.shortcut).toBe('');
  });

  it('leaves out terminal keys, Escape, the switcher itself, jump-to-N and focus-relative keys', () => {
    const actions = switcherActions(
      [
        binding({ action: 'copy', layer: 'terminal' }),
        binding({ action: 'closeDialogs' }),
        binding({ action: 'openTaskSwitcher' }),
        binding({ action: 'jumpToTask:1' }),
        binding({ action: 'navigateRow:up' }),
        binding({ action: 'navigateBoardTask:down' }),
        binding({ action: 'moveActiveTask:left' }),
        binding({ action: 'closeShell' }),
        binding({ escapeSequence: '\x1bb' }),
      ],
      onTask,
    );
    expect(actions).toEqual([]);
  });

  it('describes only actions that exist, so a renamed one is not silently unscoped', () => {
    const actions = new Set(DEFAULT_BINDINGS.map((b) => b.action));
    for (const action of Object.keys(ACTION_INFO)) expect(actions, action).toContain(action);
  });

  it('carries search keywords the description lacks', () => {
    const [finish] = switcherActions([binding({ action: 'finishTask' })], onTask);
    expect(finish?.keywords).toContain('merge');
  });

  describe('context', () => {
    const bindings = [
      binding({ action: 'finishTask', description: 'Finish task' }),
      binding({ action: 'closeTask', description: 'Close task' }),
      binding({ action: 'switchDocument', description: 'Switch document' }),
      binding({ action: 'sendPrompt', description: 'Send prompt' }),
      binding({ action: 'zoomIn', description: 'Zoom in' }),
    ];
    const listed = (context: ActionContext) =>
      switcherActions(bindings, context).map((a) => [a.id, a.detail]);

    it('names the active task beside the actions that act on it', () => {
      expect(listed(onTask)).toEqual([
        ['finishTask', 'Fix login'],
        ['closeTask', 'Fix login'],
        ['sendPrompt', 'Fix login'],
        ['zoomIn', ''],
      ]);
    });

    it('hides actions that would do nothing with no active item', () => {
      expect(listed(nothing)).toEqual([['zoomIn', '']]);
    });

    it('keeps item actions but hides task-only ones for a terminal', () => {
      const terminal = { activeName: 'Terminal 1', taskActive: false, documentOpen: false };
      expect(listed(terminal)).toEqual([
        ['closeTask', 'Terminal 1'],
        ['zoomIn', ''],
      ]);
    });

    it('offers switching document and sending its prompt inside a document workspace', () => {
      const document = { activeName: 'Notes', taskActive: false, documentOpen: true };
      expect(listed(document).map(([id]) => id)).toEqual([
        'closeTask',
        'switchDocument',
        'sendPrompt',
        'zoomIn',
      ]);
    });
  });
});

describe('recent actions', () => {
  let saved: Record<string, string>;

  beforeEach(() => {
    saved = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved[key] ?? null,
      setItem: (key: string, value: string) => {
        saved[key] = value;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers the latest action first, once, and only the last five', () => {
    let recent: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) recent = rememberAction(id, recent);
    expect(recent).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect(loadRecentActions()).toEqual(recent);
  });

  it('starts over when the saved list is unreadable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    saved['task-switcher:recent-actions'] = '{not json';
    expect(loadRecentActions()).toEqual([]);
    saved['task-switcher:recent-actions'] = JSON.stringify({ a: 1 });
    expect(loadRecentActions()).toEqual([]);
    warn.mockRestore();
  });

  it('orders recent actions first, the rest as they were', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, detail: '' }));
    expect(orderByRecency(items, ['c', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
  });
});
