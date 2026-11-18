import { beforeEach, describe, expect, it } from 'vitest';
import { setStore, store } from './core';
import { ensureTaskPortBase, taskPortEnv } from './task-ports';
import type { Task } from './types';

function task(id: string, portBase?: number): Task {
  return { id, portBase } as Task;
}

describe('task port blocks', () => {
  beforeEach(() => {
    setStore('tasks', { a: task('a', 20000), b: task('b'), c: task('c', 20020) });
  });

  it('gives a task the lowest free block and keeps it', () => {
    expect(ensureTaskPortBase('b')).toBe(20010);
    expect(store.tasks.b.portBase).toBe(20010);
    expect(ensureTaskPortBase('b')).toBe(20010);
  });

  it('hands every terminal of the task the same port', () => {
    expect(taskPortEnv('a')).toEqual({ PARALLEL_CODE_PORT: '20000' });
  });

  it('adds nothing for a terminal outside any task', () => {
    expect(taskPortEnv('arena-player')).toEqual({});
    expect(ensureTaskPortBase('arena-player')).toBeUndefined();
  });
});
