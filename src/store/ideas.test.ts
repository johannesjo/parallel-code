import { beforeEach, describe, expect, it } from 'vitest';
import { setStore, store } from './core';
import {
  addTaskIdea,
  boardIdeas,
  ideasLaneShown,
  removeTaskIdea,
  setIdeasLaneShown,
  startTaskIdea,
} from './ideas';

beforeEach(() => {
  setStore({
    taskIdeas: [],
    projects: [
      { id: 'p1', name: 'One', path: '/one', color: '#000' },
      { id: 'p2', name: 'Two', path: '/two', color: '#fff' },
    ],
    taskProjectFilter: null,
    showNewTaskPanel: false,
    newTaskPrefillPrompt: null,
  });
});

describe('task ideas', () => {
  it('adds trimmed ideas newest first and ignores blank ones', () => {
    addTaskIdea('  Dark mode  ', null);
    addTaskIdea('Offline sync', 'p1');
    addTaskIdea('   ', null);
    expect(store.taskIdeas.map((idea) => [idea.text, idea.projectId])).toEqual([
      ['Offline sync', 'p1'],
      ['Dark mode', null],
    ]);
  });

  it('shows the lane for the first idea in view only', () => {
    setIdeasLaneShown(false);
    addTaskIdea('Faster search', 'p2');
    expect(ideasLaneShown()).toBe(true);
    setIdeasLaneShown(false);
    addTaskIdea('Dark mode', null);
    expect(ideasLaneShown()).toBe(false);
    // Filtered to a project with nothing in view, the next idea is a first again.
    setStore('taskIdeas', (ideas) => ideas.filter((idea) => idea.projectId === 'p2'));
    setStore('taskProjectFilter', 'p1');
    addTaskIdea('Offline sync', 'p1');
    expect(ideasLaneShown()).toBe(true);
  });

  it('narrows by the board query and project filter, keeping ideas without a project', () => {
    addTaskIdea('Dark mode', null);
    addTaskIdea('Offline sync', 'p1');
    addTaskIdea('Faster search', 'p2');
    setStore('taskProjectFilter', 'p1');
    expect(boardIdeas('').map((idea) => idea.text)).toEqual(['Offline sync', 'Dark mode']);
    expect(boardIdeas(' SYNC ').map((idea) => idea.text)).toEqual(['Offline sync']);
  });

  it('starts a task from an idea without replacing an open draft', () => {
    addTaskIdea('Offline sync', 'p1');
    const id = store.taskIdeas[0].id;
    setStore('showNewTaskPanel', true);
    expect(startTaskIdea(id)).toBe(false);
    setStore('showNewTaskPanel', false);
    expect(startTaskIdea(id)).toBe(true);
    expect(store.newTaskPrefillPrompt).toMatchObject({
      prompt: 'Offline sync',
      projectId: 'p1',
      ideaId: id,
    });
    expect(store.showNewTaskPanel).toBe(true);
    // The idea stays until the task is actually created.
    expect(store.taskIdeas).toHaveLength(1);
    removeTaskIdea(id);
    expect(store.taskIdeas).toEqual([]);
  });
});
