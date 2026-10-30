import { afterEach, describe, expect, it } from 'vitest';
import { produce } from 'solid-js/store';
import { setStore } from './core';
import { projectIdForPath } from './project-path';
import type { Project, Task } from './types';

describe('projectIdForPath', () => {
  afterEach(() => {
    setStore({ projects: [] });
    setStore(
      produce((s) => {
        s.tasks = {};
      }),
    );
  });

  it("finds the project of a task's worktree or of a project folder", () => {
    setStore('projects', [{ id: 'p1', name: 'App', path: '/repo' } as Project]);
    setStore('tasks', 'task-1', { id: 'task-1', projectId: 'p1', worktreePath: '/wt/one' } as Task);
    expect(projectIdForPath('/wt/one')).toBe('p1');
    expect(projectIdForPath('/repo')).toBe('p1');
    expect(projectIdForPath('/elsewhere')).toBeUndefined();
  });
});
