import { describe, expect, it } from 'vitest';
import { resolveBindings, findConflict } from '../resolve';
import { DEFAULT_BINDINGS } from '../defaults';

describe('resolveBindings', () => {
  it('returns defaults unchanged when no preset or user overrides', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });
    const navLeft = resolved.find((b) => b.id === 'app.nav.column-left');
    expect(navLeft?.key).toBe('ArrowLeft');
    expect(navLeft?.modifiers.alt).toBe(true);
  });

  it('applies preset overrides on top of defaults', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, {
      preset: 'claude-code',
      userOverrides: {},
    });
    // Claude Code preset unbinds Option+Left for column nav
    const navLeft = resolved.find((b) => b.id === 'app.nav.column-left');
    expect(navLeft).toBeUndefined(); // null override removes the binding
  });

  it('applies user overrides on top of preset', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, {
      preset: 'claude-code',
      userOverrides: {
        'app.toggle-sidebar': { key: 'b', modifiers: { cmdOrCtrl: true, shift: true } },
      },
    });
    const sidebar = resolved.find((b) => b.id === 'app.toggle-sidebar');
    expect(sidebar?.modifiers.shift).toBe(true);
  });

  it('user override of null unbinds the key', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, {
      preset: 'default',
      userOverrides: { 'app.toggle-sidebar': null },
    });
    const sidebar = resolved.find((b) => b.id === 'app.toggle-sidebar');
    expect(sidebar).toBeUndefined();
  });

  it('unknown preset falls back to default', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, {
      preset: 'nonexistent',
      userOverrides: {},
    });
    // Should have same count as defaults filtered to current platform
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe('findConflict', () => {
  it('detects conflict when two bindings share the same key+modifiers', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });
    // Try to assign Cmd+B (toggle-sidebar's binding) to new-task
    const conflict = findConflict(resolved, 'app.new-task', {
      key: 'b',
      modifiers: { cmdOrCtrl: true },
    });
    expect(conflict?.id).toBe('app.toggle-sidebar');
  });

  it('returns null when no conflict exists', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });
    const conflict = findConflict(resolved, 'app.new-task', {
      key: 'F12',
      modifiers: {},
    });
    expect(conflict).toBeNull();
  });

  it('ignores the binding being edited (no self-conflict)', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });
    const conflict = findConflict(resolved, 'app.toggle-sidebar', {
      key: 'b',
      modifiers: { cmdOrCtrl: true },
    });
    expect(conflict).toBeNull();
  });
});
