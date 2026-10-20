import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from './core';
import {
  addIssuesToBoard,
  advanceKanbanCard,
  issueBoardColumn,
  linkNewTaskToKanbanCard,
  openKanban,
  startKanbanAutomation,
  startKanbanCardTask,
  updateKanbanFile,
} from './kanban';
import { showNotification } from './notification';
import { addCard, parseKanban } from '../lib/kanban';
import type { Task } from './types';

const disk = vi.hoisted(() => ({ text: null as string | null, conflicts: 0 }));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string, args: { content?: string; expected?: string | null }) => {
    if (channel === 'read_kanban_board') return disk.text;
    if (channel === 'write_kanban_board') {
      if (disk.conflicts > 0) {
        // Someone else edits the file between our read and our write.
        disk.conflicts--;
        disk.text = `${disk.text ?? ''}\n- [ ] Added elsewhere\n`;
      }
      if (args.expected !== disk.text) throw new Error('KANBAN.md changed on disk');
      disk.text = args.content ?? null;
    }
    return undefined;
  }),
}));
vi.mock('./core', async () => {
  const { createStore } = await import('solid-js/store');
  const [store, setStore] = createStore({
    tasks: {} as Record<string, Task>,
    showNewTaskPanel: false,
    newTaskPrefillPrompt: null as unknown,
    githubIssuesProjectId: null as string | null,
    kanbanProjectId: null as string | null,
  });
  return { store, setStore };
});
vi.mock('./navigation', () => ({ toggleNewTaskPanel: vi.fn() }));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./notification', () => ({ showNotification: vi.fn() }));
vi.mock('./github-agent', () => ({ ensureProjectAgentTask: vi.fn() }));
vi.mock('./tasks', () => ({ setPrefillPrompt: vi.fn() }));
vi.mock('./pr-checks-state', () => ({ getPrChecks: () => undefined }));

const BOARD = `# Plan

## Backlog

## In progress

- [ ] Sync engine
  branch: \`task/sync\`

## Review

## Done
`;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  disk.text = BOARD;
  disk.conflicts = 0;
  setStore('tasks', {});
});

afterEach(() => vi.clearAllMocks());

describe('updateKanbanFile', () => {
  it('retries on the new text when another edit wins the race', async () => {
    disk.conflicts = 1;
    const changed = await updateKanbanFile('/repo', (b) => addCard(b, 0, 'Mine'));
    expect(changed).toBe(true);
    expect(disk.text).toContain('- [ ] Mine');
    expect(disk.text).toContain('Added elsewhere');
  });

  it('leaves a project without a board alone', async () => {
    disk.text = null;
    expect(await updateKanbanFile('/repo', (b) => addCard(b, 0, 'x'))).toBe(false);
    expect(disk.text).toBeNull();
  });
});

describe('card automation', () => {
  it('moves a card to Done when its branch merged', async () => {
    await advanceKanbanCard('p1', 'task/sync', 'done');
    expect(disk.text).toMatch(/## Done\n\n- \[x\] Sync engine/);
  });

  it('moves a card to Review when its task signals done, but not on startup', async () => {
    const task = {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      signalDoneReceived: true,
    } as Task;
    setStore('tasks', 't1', task);
    const stop = startKanbanAutomation();
    await flush();
    // Already done when the app started: the board is not rewritten.
    expect(disk.text).toBe(BOARD);
    setStore('tasks', 't2', { ...task, id: 't2', signalDoneReceived: false });
    await flush();
    setStore('tasks', 't2', 'signalDoneReceived', true);
    await flush();
    expect(disk.text).toMatch(/## Review\n\n- \[ \] Sync engine/);
    stop();
  });
});

describe('linking tasks to cards', () => {
  const source = {
    projectId: 'p1',
    title: 'Sync engine',
    column: 'In progress',
    ref: { column: 1, card: 0 },
  };

  it('links a worktree task by its branch', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/new',
      gitIsolation: 'worktree',
    } as Task);
    await linkNewTaskToKanbanCard('t1', source, 'p1');
    expect(disk.text).toContain('  branch: `task/sync`\n  branch: `task/new`');
  });

  it('does not link a direct task to the shared base branch, and says so', async () => {
    setStore('tasks', 't2', {
      id: 't2',
      projectId: 'p1',
      branchName: 'main',
      gitIsolation: 'direct',
    } as Task);
    await linkNewTaskToKanbanCard('t2', source, 'p1');
    expect(disk.text).toBe(BOARD);
    expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('was not linked'));
  });
});

describe('GitHub issues on the board', () => {
  const issue = { title: 'Crash on start', url: 'https://github.com/acme/app/issues/12' };

  it('adds issues once and reports the column they are in', async () => {
    expect(await addIssuesToBoard('p1', [issue, issue])).toEqual({
      added: 1,
      created: false,
      column: 'Backlog',
    });
    expect((await addIssuesToBoard('p1', [issue]))?.added).toBe(0);
    expect(disk.text).toContain(
      '- [ ] Crash on start\n  issue: https://github.com/acme/app/issues/12',
    );
    expect(await issueBoardColumn('p1', issue.url)).toBe('Backlog');
  });

  it('creates the board when the project has none', async () => {
    disk.text = null;
    expect(await addIssuesToBoard('p1', [issue])).toMatchObject({ added: 1, created: true });
    expect(disk.text).toContain('## Backlog\n\n- [ ] Crash on start');
  });

  it('does not make a pull request card the new task’s own PR', () => {
    const pr = 'https://github.com/acme/app/pull/7';
    const board = parseKanban(`## Todo\n\n- [ ] Review\n  issue: ${pr}\n`);
    expect(startKanbanCardTask('p1', board, { column: 0, card: 0 })).toBe(true);
    expect((store.newTaskPrefillPrompt as { githubUrl?: string }).githubUrl).toBeUndefined();
    setStore('showNewTaskPanel', false);
  });

  it('links a task started from an issue card to the issue', () => {
    const board = parseKanban(`## Todo\n\n- [ ] Crash\n  issue: ${issue.url}\n`);
    expect(startKanbanCardTask('p1', board, { column: 0, card: 0 })).toBe(true);
    expect(store.newTaskPrefillPrompt).toMatchObject({ githubUrl: issue.url, name: 'Crash' });
  });
});

describe('project pages', () => {
  it('opening the board closes the GitHub page', () => {
    setStore('githubIssuesProjectId', 'p1');
    openKanban('p1');
    expect(store.githubIssuesProjectId).toBeNull();
    expect(store.kanbanProjectId).toBe('p1');
    openKanban(null);
    expect(store.kanbanProjectId).toBeNull();
  });
});
