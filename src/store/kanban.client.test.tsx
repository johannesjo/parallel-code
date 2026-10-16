import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from './core';
import { advanceKanbanCard, startKanbanAutomation, updateKanbanFile } from './kanban';
import { addCard } from '../lib/kanban';
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
  const [store, setStore] = createStore({ tasks: {} as Record<string, Task> });
  return { store, setStore };
});
vi.mock('./navigation', () => ({ toggleNewTaskPanel: vi.fn() }));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./notification', () => ({ showNotification: vi.fn() }));
vi.mock('./github-agent', () => ({ prefillGitHubAgentPrompt: vi.fn() }));
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
