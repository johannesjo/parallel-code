import { describe, expect, it, vi } from 'vitest';

vi.mock('solid-js/store', () => ({
  createStore: <T>(v: T) => [v, vi.fn()] as const,
}));
vi.mock('../lib/fonts', () => ({ DEFAULT_TERMINAL_FONT: 'mono' }));
vi.mock('../lib/date', () => ({ getLocalDateKey: () => '2026-04-24' }));

import { cleanupPanelEntries } from './core';

function makeSlice(
  panelUserSize: Record<string, number>,
  taskOrder: string[] = ['abc'],
): Parameters<typeof cleanupPanelEntries>[0] {
  return {
    focusedPanel: {},
    panelUserSize,
    taskOrder,
    collapsedTaskOrder: [],
    taskSplitMode: {},
    taskShellAutoLayout: {},
  };
}

describe('cleanupPanelEntries', () => {
  it('drops task:${id}:* keys from panelUserSize', () => {
    const s = makeSlice({
      'task:abc:ai-terminal': 400,
      'task:abc:split-right:shell-section': 200,
      'task:abc:notes-split:notes': 300,
      'task:other:ai-terminal': 123,
    });
    cleanupPanelEntries(s, 'abc');
    expect(s.panelUserSize).toEqual({ 'task:other:ai-terminal': 123 });
  });

  it('drops tiling:${id} keys from panelUserSize', () => {
    const s = makeSlice({
      'tiling:abc': 520,
      'tiling:other': 480,
      'sidebar:width': 240,
    });
    cleanupPanelEntries(s, 'abc');
    expect(s.panelUserSize).toEqual({
      'tiling:other': 480,
      'sidebar:width': 240,
    });
  });

  it('still drops bare-id / id:* keys (legacy)', () => {
    const s = makeSlice({
      abc: 100,
      'abc:sub': 200,
      other: 300,
    });
    cleanupPanelEntries(s, 'abc');
    expect(s.panelUserSize).toEqual({ other: 300 });
  });

  it('returns the index of the id in taskOrder and removes it', () => {
    const s = makeSlice({}, ['first', 'abc', 'third']);
    const idx = cleanupPanelEntries(s, 'abc');
    expect(idx).toBe(1);
    expect(s.taskOrder).toEqual(['first', 'third']);
  });

  it('does not delete unrelated keys', () => {
    const s = makeSlice({
      'task:abc:ai-terminal': 400,
      'tiling:abc': 520,
      'task:abcdef:something': 100, // different id, shouldn't match abc's prefixes
      'tiling:abcdef': 200,
    });
    cleanupPanelEntries(s, 'abc');
    expect(s.panelUserSize).toEqual({
      'task:abcdef:something': 100,
      'tiling:abcdef': 200,
    });
  });
});
