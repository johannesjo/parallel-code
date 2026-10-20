/* eslint-disable solid/reactivity -- these tests read the store proxy synchronously to exercise isKnownTask; no reactive tracking is involved. */
import { describe, it, expect } from 'vitest';
import { createStore } from 'solid-js/store';
import { isKnownTask, remoteSkipPermissions } from './remoteTaskHandler';

// Guards the prototype-pollution fix: a mobile HTTP request supplies the task
// id, and Solid's store proxy resolves inherited keys to prototype objects.
// isKnownTask must accept only real own task entries so that a later
// updateTaskNotes -> setStore('tasks', id, 'notes', …) can never target
// Object.prototype / Function.prototype via an inherited key.
describe('isKnownTask', () => {
  const [store] = createStore<{ tasks: Record<string, { notes: string }> }>({
    tasks: { 'task-1': { notes: '' }, 'task-2': { notes: 'x' } },
  });

  it('accepts real own task ids', () => {
    expect(isKnownTask(store.tasks, 'task-1')).toBe(true);
    expect(isKnownTask(store.tasks, 'task-2')).toBe(true);
  });

  it('rejects missing ids', () => {
    expect(isKnownTask(store.tasks, 'nope')).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects the inherited/dangerous key %s',
    (key) => {
      expect(isKnownTask(store.tasks, key)).toBe(false);
    },
  );

  it('would be fooled by a truthiness guard on the same proxy (documents why hasOwn is needed)', () => {
    // These inherited keys read back truthy through the store proxy, which is
    // exactly the trap the old `if (!store.tasks[id])` guard fell into.
    const proxied = store.tasks as Record<string, unknown>;
    expect(Boolean(proxied['constructor'])).toBe(true);
    expect(Boolean(proxied['toString'])).toBe(true);
    // …yet isKnownTask correctly rejects them.
    expect(isKnownTask(store.tasks, 'constructor')).toBe(false);
    expect(isKnownTask(store.tasks, 'toString')).toBe(false);
  });
});

// handleCreateTask never passed skipPermissions at all, so a task created from
// a paired phone launched bare no matter what the setting said. The decision
// mirrors the New Task dialog: the stored default, but only for an agent that
// actually takes such a flag.
describe('remoteSkipPermissions', () => {
  const claude = { command: 'claude', skip_permissions_args: ['--dangerously-skip-permissions'] };

  it('opts in when the setting is on and the agent takes the flag', () => {
    expect(remoteSkipPermissions(true, claude)).toBe(true);
  });

  it('stays off when the setting is off', () => {
    expect(remoteSkipPermissions(false, claude)).toBe(false);
  });

  it('stays off for an agent that takes no such flag, even with the setting on', () => {
    expect(remoteSkipPermissions(true, { command: 'opencode' })).toBe(false);
  });

  // The same degraded def the desktop paths have to cope with.
  it('opts in for a def that carries no flags but whose command takes one', () => {
    expect(remoteSkipPermissions(true, { command: 'claude', skip_permissions_args: [] })).toBe(
      true,
    );
    expect(remoteSkipPermissions(true, { command: '/opt/homebrew/bin/claude' })).toBe(true);
  });
});
