import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { KanbanPage } from './KanbanPage';
import { setStore, store } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import type { Task } from '../store/types';

const disk = vi.hoisted(() => ({ text: null as string | null }));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string, args: { content?: string; expected?: string | null }) => {
    if (channel === 'read_kanban_board') return disk.text;
    if (channel === 'write_kanban_board') {
      if (args.expected !== disk.text) throw new Error('KANBAN.md changed on disk');
      disk.text = args.content ?? null;
    }
    return undefined;
  }),
}));
vi.mock('../store/core', async () => {
  const { createStore } = await import('solid-js/store');
  const [store, setStore] = createStore({
    projects: [],
    tasks: {},
    showNewTaskPanel: false,
    githubIssuesProjectId: null,
    kanbanProjectId: null,
    kanbanEnabled: true,
    newTaskPrefillPrompt: null,
    editorCommand: '',
  });
  return { store, setStore };
});
vi.mock('../store/navigation', async () => {
  const { setStore } = await import('../store/core');
  return {
    setActiveTask: vi.fn(),
    toggleNewTaskPanel: vi.fn((show: boolean) => setStore('showNewTaskPanel', show)),
  };
});
vi.mock('../store/tasks', () => ({ uncollapseTask: vi.fn() }));
vi.mock('../store/projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('../store/notification', () => ({ showNotification: vi.fn() }));

const BOARD = `# Plan

## Backlog

- [ ] Write migration
  Move the records.

## In progress

- [ ] Sync engine
  branch: \`task/sync\`

## Done
`;

let host: HTMLDivElement;
let dispose: (() => void) | undefined;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(): Promise<void> {
  dispose = render(() => <KanbanPage />, host);
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

beforeEach(() => {
  disk.text = BOARD;
  host = document.createElement('div');
  document.body.append(host);
  setStore(
    reconcile({
      projects: [{ id: 'p1', name: 'Repo', path: '/repo', color: '#888' }],
      tasks: {},
      showNewTaskPanel: false,
      githubIssuesProjectId: null,
      kanbanProjectId: 'p1',
      kanbanEnabled: true,
      newTaskPrefillPrompt: null,
      editorCommand: '',
    } as never),
  );
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  host.remove();
});

describe('KanbanPage', () => {
  it('shows the columns and cards of KANBAN.md', async () => {
    await mount();
    const columns = [...host.querySelectorAll('.kanban-column h3')].map((h) => h.textContent);
    expect(columns).toEqual(['Backlog1', 'In progress1', 'Done0']);
    expect(host.textContent).toContain('Write migration');
    expect(host.textContent).toContain('Move the records.');
    // No open task works on the recorded branch, so it shows as plain text.
    expect(host.querySelector('.kanban-branch')?.textContent).toBe('task/sync');
  });

  it('links a recorded branch to its open task', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      name: 'Build sync engine',
      projectId: 'p1',
      branchName: 'task/sync',
    } as Task);
    await mount();
    expect(host.querySelector('.kanban-task-link')?.textContent).toContain('Build sync engine');
  });

  it('offers to create the board when the project has none', async () => {
    disk.text = null;
    await mount();
    expect(host.textContent).toContain('no Kanban board yet');
    button('Create board').click();
    await settle();
    expect(disk.text).toContain('## Backlog');
    expect(host.querySelectorAll('.kanban-column')).toHaveLength(4);
  });

  it('adds a card and writes it to the file', async () => {
    await mount();
    button('Add card').click();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="New card title"]');
    if (!input) throw new Error('no input');
    input.value = 'Docs';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(disk.text).toContain('- [ ] Write migration\n  Move the records.\n- [ ] Docs');
  });

  it('checks a card off', async () => {
    await mount();
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Done: Write migration"]');
    if (!box) throw new Error('no checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(disk.text).toContain('- [x] Write migration');
  });

  it('starts a task prefilled from the card', async () => {
    await mount();
    button('Start task').click();
    expect(store.showNewTaskPanel).toBe(true);
    expect(store.kanbanProjectId).toBeNull();
    expect(store.newTaskPrefillPrompt).toMatchObject({
      projectId: 'p1',
      name: 'Write migration',
      kanban: { projectId: 'p1', title: 'Write migration', column: 'Backlog' },
    });
    expect(store.newTaskPrefillPrompt?.prompt).toContain('Move the records.');
  });

  it('reloads after a refused write instead of overwriting', async () => {
    await mount();
    disk.text = BOARD.replace('Write migration', 'Edited elsewhere');
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Done: Write migration"]');
    if (!box) throw new Error('no checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(disk.text).toContain('- [ ] Edited elsewhere');
    expect(host.textContent).toContain('Edited elsewhere');
  });
});

it('uses the kanban channels', () => {
  expect(IPC.ReadKanbanBoard).toBe('read_kanban_board');
  expect(IPC.WriteKanbanBoard).toBe('write_kanban_board');
});
