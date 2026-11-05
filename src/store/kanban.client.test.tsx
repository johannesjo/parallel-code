import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { setStore, store } from './core';
import {
  addIssuesToBoard,
  advanceKanbanCard,
  issueBoardColumn,
  linkNewTaskToKanbanCard,
  openKanban,
  showPlanTasks,
  startKanbanAutomation,
  startKanbanCardTask,
  updateKanbanFile,
} from './kanban';
import { showNotification } from './notification';
import {
  extraPrWatchId,
  forgetTaskPrsDetected,
  markTaskPrsDetected,
  markTaskPrsListed,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  type PrChecksState,
} from './pr-checks-state';
import { closeProjectPages } from './project-pages';
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
    boardView: false,
    boardPeek: false,
    projects: [] as unknown[],
    taskProjectFilter: null as string | null,
  });
  return { store, setStore };
});
vi.mock('./navigation', () => ({
  toggleNewTaskPanel: vi.fn(),
  setTaskProjectFilter: (id: string | null) => setStore('taskProjectFilter', id),
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./notification', () => ({ showNotification: vi.fn() }));
vi.mock('./github-agent', () => ({ ensureProjectAgentTask: vi.fn() }));
vi.mock('./tasks', () => ({ setPrefillPrompt: vi.fn() }));

// Reactive stand-ins: a test sets `attention` and `gitKnown` on the task.
vi.mock('./taskStatus', () => ({
  getTaskAttentionState: (id: string) =>
    (store.tasks[id] as { attention?: string } | undefined)?.attention ?? 'idle',
  isTaskGitStatusKnown: (id: string) =>
    (store.tasks[id] as { gitKnown?: boolean } | undefined)?.gitKnown ?? true,
}));

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
  // Replaced, not merged: a task left by the last test would carry its state over.
  setStore('tasks', reconcile({}));
});

afterEach(() => {
  vi.clearAllMocks();
  setTaskExtraPrs('t1', []);
  forgetTaskPrsDetected();
});

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

  it('moves a card to Review when its task opens a PR in a nested repository', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
    } as Task);
    const stop = startKanbanAutomation();
    await flush();
    setTaskExtraPrs('t1', [{ url: 'https://github.com/acme/lib/pull/3', repo: 'lib' }]);
    await flush();
    expect(disk.text).toMatch(/## Review\n\n- \[ \] Sync engine/);
    setTaskExtraPrs('t1', []);
    stop();
  });

  it("leaves the card when a restart finds the task's nested PR again", async () => {
    // Additional PRs are not saved, so branch detection lists them anew after a restart.
    setStore('tasks', 't1', {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/sync',
    } as Task);
    const stop = startKanbanAutomation();
    await flush();
    setTaskExtraPrs('t1', [{ url: 'https://github.com/acme/lib/pull/3', repo: 'lib' }]);
    markTaskPrsDetected('t1');
    await flush();
    expect(disk.text).toBe(BOARD);
    stop();
  });

  it('moves a card to Review when a nested PR opens after its PRs were listed', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/sync',
    } as Task);
    markTaskPrsDetected('t1');
    const stop = startKanbanAutomation();
    await flush();
    setTaskExtraPrs('t1', [{ url: 'https://github.com/acme/lib/pull/3', repo: 'lib' }]);
    await flush();
    expect(disk.text).toMatch(/## Review\n\n- \[ \] Sync engine/);
    stop();
  });

  it('moves a card to Review when a nested PR opens though another repository could not be listed', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/sync',
    } as Task);
    // A repository gh cannot list, e.g. one on another host, fails every probe.
    markTaskPrsListed('t1');
    const stop = startKanbanAutomation();
    await flush();
    setTaskExtraPrs('t1', [{ url: 'https://github.com/acme/lib/pull/3', repo: 'lib' }]);
    await flush();
    expect(disk.text).toMatch(/## Review\n\n- \[ \] Sync engine/);
    stop();
  });

  it('leaves the card of a task with its own PR when it opens another', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/sync',
      prUrl: 'https://github.com/acme/app/pull/12',
    } as Task);
    markTaskPrsDetected('t1');
    const stop = startKanbanAutomation();
    await flush();
    setTaskExtraPrs('t1', [{ url: 'https://github.com/acme/lib/pull/3', repo: 'lib' }]);
    await flush();
    expect(disk.text).toBe(BOARD);
    stop();
  });

  it('leaves the card of a task with a nested PR when it opens its own', async () => {
    setStore('tasks', 't1', {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/sync',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/sync',
    } as Task);
    setTaskExtraPrs('t1', [{ url: 'https://github.com/acme/lib/pull/3', repo: 'lib' }]);
    markTaskPrsDetected('t1');
    const stop = startKanbanAutomation();
    await flush();
    setStore('tasks', 't1', 'prUrl', 'https://github.com/acme/app/pull/12');
    await flush();
    expect(disk.text).toBe(BOARD);
    stop();
  });

  const worktreeTask = (id: string, branchName: string) =>
    ({ id, projectId: 'p1', branchName, gitIsolation: 'worktree' }) as Task;

  it('moves a card to Review when its agent finishes with its work committed', async () => {
    setStore('tasks', 't1', { ...worktreeTask('t1', 'task/sync'), attention: 'active' } as Task);
    const stop = startKanbanAutomation();
    await flush();
    // A git refresh in between says nothing either way.
    setStore('tasks', 't1', { attention: 'idle', gitKnown: false } as never);
    await flush();
    setStore('tasks', 't1', { attention: 'ready', gitKnown: true } as never);
    await flush();
    expect(disk.text).toMatch(/## Review\n\n- \[ \] Sync engine/);
    stop();
  });

  it('moves a card to Done only once every PR of its task merged', async () => {
    const extraUrl = 'https://github.com/acme/lib/pull/3';
    const merged = { overall: 'none', merged: true, checks: [] } as unknown as PrChecksState;
    setStore('tasks', 't1', {
      ...worktreeTask('t1', 'task/sync'),
      worktreePath: '/repo/.worktrees/sync',
      prUrl: 'https://github.com/acme/app/pull/12',
    } as Task);
    const stop = startKanbanAutomation();
    await flush();
    // Merged before detection found the task's other PRs, as after a restart.
    setPrChecks('t1', merged);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disk.text).not.toMatch(/## Done\n\n- \[x\] Sync engine/);
    setTaskExtraPrs('t1', [{ url: extraUrl, repo: 'lib' }]);
    markTaskPrsDetected('t1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disk.text).not.toMatch(/## Done\n\n- \[x\] Sync engine/);
    setPrChecks(extraPrWatchId('t1', extraUrl), merged);
    await flush();
    expect(disk.text).toMatch(/## Done\n\n- \[x\] Sync engine/);
    stop();
    setTaskExtraPrs('t1', []);
    removePrChecks('t1');
    removePrChecks(extraPrWatchId('t1', extraUrl));
  });

  it('leaves the card of a task that was already ready at startup', async () => {
    setStore('tasks', 't1', { ...worktreeTask('t1', 'task/sync'), gitKnown: false } as Task);
    const stop = startKanbanAutomation();
    await flush();
    setStore('tasks', 't1', { attention: 'ready', gitKnown: true } as never);
    // Long enough for a board write to land, had one started.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disk.text).toBe(BOARD);
    stop();
  });

  it('checks a card off when its task is closed', async () => {
    setStore('tasks', 't1', worktreeTask('t1', 'task/sync'));
    const stop = startKanbanAutomation();
    await flush();
    setStore('tasks', 't1', undefined as unknown as Task);
    await flush();
    expect(disk.text).toMatch(/## Done\n\n- \[x\] Sync engine/);
    stop();
  });

  it('keeps a card open while another of its tasks is still open', async () => {
    disk.text = BOARD.replace('branch: `task/sync`', 'branch: `task/sync`\n  branch: `task/b`');
    const before = disk.text;
    setStore('tasks', 't1', worktreeTask('t1', 'task/sync'));
    setStore('tasks', 't2', worktreeTask('t2', 'task/b'));
    const stop = startKanbanAutomation();
    await flush();
    setStore('tasks', 't1', undefined as unknown as Task);
    await flush();
    expect(disk.text).toBe(before);
    stop();
  });
});

describe('linking tasks to cards', () => {
  it('moves a backlog card to In progress when a task starts on it', async () => {
    disk.text = BOARD.replace('## Backlog\n', '## Backlog\n\n- [ ] Docs\n');
    setStore('tasks', 't1', {
      id: 't1',
      projectId: 'p1',
      branchName: 'task/docs',
      gitIsolation: 'worktree',
    } as Task);
    await linkNewTaskToKanbanCard(
      't1',
      { projectId: 'p1', title: 'Docs', column: 'Backlog', ref: { column: 0, card: 0 } },
      'p1',
    );
    expect(disk.text).toMatch(/## In progress\n\n- \[ \] Docs\n {2}branch: `task\/docs`/);
  });

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

  it('confirms what it added', async () => {
    const other = { title: 'Slow search', url: 'https://github.com/acme/app/issues/13' };
    await addIssuesToBoard('p1', [issue]);
    expect(showNotification).toHaveBeenLastCalledWith('Added 1 card to Backlog');
    await addIssuesToBoard('p1', [issue, other]);
    expect(showNotification).toHaveBeenLastCalledWith(
      'Added 1 card to Backlog; 1 already on the plan',
    );
    await addIssuesToBoard('p1', [issue]);
    expect(showNotification).toHaveBeenLastCalledWith('Already on the plan');
  });

  it('does not count an item picked twice as already on the plan', async () => {
    await addIssuesToBoard('p1', [issue, issue]);
    expect(showNotification).toHaveBeenLastCalledWith('Added 1 card to Backlog');
  });

  it('creates the board when the project has none', async () => {
    disk.text = null;
    expect(await addIssuesToBoard('p1', [issue])).toMatchObject({ added: 1, created: true });
    expect(disk.text).toContain('## Backlog\n\n- [ ] Crash on start');
    expect(showNotification).toHaveBeenLastCalledWith('Created KANBAN.md with 1 card in Backlog');
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
  it('opening a plan shows it on the board and closes the GitHub page', () => {
    setStore('githubIssuesProjectId', 'p1');
    openKanban('p1');
    expect(store.githubIssuesProjectId).toBeNull();
    expect(store.boardView).toBe(true);
    expect(store.kanbanProjectId).toBe('p1');
    openKanban(null);
    expect(store.kanbanProjectId).toBeNull();
    expect(store.boardView).toBe(true);
  });

  it('steps from a plan to the running tasks of its project only', () => {
    setStore('taskProjectFilter', null);
    openKanban('p1');
    showPlanTasks();
    expect(store.kanbanProjectId).toBeNull();
    expect(store.boardView).toBe(true);
    expect(store.taskProjectFilter).toBe('p1');
  });

  it('keeps the plan while the board stays, and forgets it when the board closes', () => {
    openKanban('p1');
    closeProjectPages({ keepBoard: true });
    expect(store.kanbanProjectId).toBe('p1');
    closeProjectPages();
    expect(store.boardView).toBe(false);
    expect(store.kanbanProjectId).toBeNull();
  });
});
