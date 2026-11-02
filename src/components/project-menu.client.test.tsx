import { beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import type { Project } from '../store/types';
import { projectMenuItems } from './project-menu';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

const code: Project = { id: 'code', name: 'Code', path: '/repo', color: '#888' };
const docs: Project = { ...code, id: 'docs', kind: 'document', documentPath: 'notes.md' };
const dialogs = { editSettings: vi.fn(), remove: vi.fn() };
const labels = (project: Project, missing = false) =>
  projectMenuItems(project, missing, dialogs).map((item) => item.label);

beforeEach(() => {
  setStore('editorCommand', '');
  setStore('kanbanProjectId', null);
  setStore('githubIssuesProjectId', null);
  setStore('showNewTaskPanel', false);
  setStore('newTaskPrefillPrompt', null);
});

it('offers a new task, the project views, its folder, settings and removal for a code project', () => {
  expect(labels(code)).toEqual([
    'New task',
    'Plan board',
    'GitHub issues',
    'Show in file manager',
    'Settings…',
    'Remove project…',
  ]);
});

it('opens the folder in the configured editor when there is one', () => {
  setStore('editorCommand', 'code');
  expect(labels(code)).toContain('Open in editor');
});

it('offers a document workspace instead of the code views', () => {
  expect(labels(docs)).toEqual(['Open workspace', 'Settings…', 'Remove project…']);
});

it('keeps only settings and removal when the folder is missing', () => {
  expect(labels(code, true)).toEqual(['Settings…', 'Remove project…']);
});

it('opens the chosen view and dialogs', () => {
  const items = projectMenuItems(code, false, dialogs);
  const run = (label: string) => items.find((item) => item.label === label)?.run?.();
  run('GitHub issues');
  expect(store.githubIssuesProjectId).toBe('code');
  run('Plan board');
  expect(store.kanbanProjectId).toBe('code');
  run('Settings…');
  expect(dialogs.editSettings).toHaveBeenCalledWith(code);
  run('Remove project…');
  expect(dialogs.remove).toHaveBeenCalledWith('code');
});

it('opens a blank new-task form for the project', () => {
  setStore('projects', [code]);
  projectMenuItems(code, false, dialogs)
    .find((item) => item.label === 'New task')
    ?.run?.();
  expect(store.showNewTaskPanel).toBe(true);
  expect(store.newTaskPrefillPrompt).toMatchObject({ projectId: 'code', prompt: '', name: '' });
});

it('keeps an open draft when starting a new task', () => {
  setStore('projects', [code]);
  setStore('showNewTaskPanel', true);
  setStore('newTaskPrefillPrompt', { prompt: 'draft', projectId: 'other' });
  projectMenuItems(code, false, dialogs)
    .find((item) => item.label === 'New task')
    ?.run?.();
  expect(store.newTaskPrefillPrompt?.prompt).toBe('draft');
});
