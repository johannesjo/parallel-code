// The hook wiring needs a window with an ipcRenderer, so this runs in the
// client (happy-dom) config over the real store; only IPC and saving are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { store, setStore } from './core';
import {
  activateCanvasTab,
  closeCanvasTab,
  closeTaskCanvas,
  applyPlanContent,
  openCanvasDocument,
  openTaskCanvas,
  startCanvasAutoOpen,
} from './canvas';
import { deletePanelUserSize, getPanelUserSize, setPanelUserSize } from './ui';
import type { Agent, Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./persistence')>()),
  saveState: vi.fn(async () => undefined),
}));

let hookListeners: Array<(payload: unknown) => void> = [];
let stop: (() => void) | undefined;

const task: Task = {
  id: 'task-1',
  name: 'Task',
  projectId: 'project-1',
  branchName: 'task/plan',
  worktreePath: '/tmp/task',
  agentIds: ['agent-1'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
};

const agentFor = (command: string): Agent => ({
  id: 'agent-1',
  taskId: 'task-1',
  def: {
    id: command,
    name: command,
    command,
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
  },
  resumed: false,
  status: 'running',
  exitCode: null,
  signal: null,
  lastOutput: [],
  generation: 0,
});

const md = (path: string) => ({ kind: 'markdown' as const, path });
const openPaths = () => store.tasks['task-1'].canvasTabs?.map((t) => t.path);
const activePath = () => store.tasks['task-1'].canvasActiveTab?.replace('markdown:', '');

beforeEach(() => {
  hookListeners = [];
  Object.assign(window, {
    electron: {
      ipcRenderer: {
        on: (channel: string, cb: (payload: unknown) => void) => {
          if (channel === IPC.AgentHookEvent) hookListeners.push(cb);
          return () => undefined;
        },
      },
    },
  });
  setStore('tasks', 'task-1', { ...task });
  stop = startCanvasAutoOpen();
});

afterEach(() => {
  stop?.();
  setStore('tasks', 'task-1', {
    canvasTabs: undefined,
    canvasActiveTab: undefined,
    canvasOpen: undefined,
    planPath: undefined,
    livePlanPath: undefined,
  });
  setStore(
    'agents',
    produce((agents) => {
      delete agents['agent-1'];
    }),
  );
  deletePanelUserSize(['tiling:task-1', 'task:task-1:canvas-cols:canvas']);
  vi.mocked(invoke).mockReset();
});

function fire(payload: Record<string, unknown>): void {
  for (const cb of hookListeners) {
    cb({ agentId: 'agent-1', taskId: 'task-1', at: 1, ...payload });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const publish = (relativePath: string | null, recovered?: boolean) =>
  applyPlanContent({
    taskId: 'task-1',
    content: relativePath && '# Plan',
    fileName: relativePath?.split('/').at(-1) ?? null,
    relativePath,
    recovered,
  });

describe('applyPlanContent', () => {
  it('opens a plan this session wrote', () => {
    publish('.claude/plans/p.md');
    expect(activePath()).toBe('.claude/plans/p.md');
    expect(store.tasks['task-1'].planContent).toBe('# Plan');
  });

  it('shows a plan found on disk in the plan tab without taking the canvas', () => {
    publish('.claude/plans/old.md', true);
    expect(store.tasks['task-1'].planContent).toBe('# Plan');
    expect(store.tasks['task-1'].planPath).toBe('.claude/plans/old.md');
    expect(openPaths()).toBeUndefined();
  });

  // The watcher restarts on every agent spawn and republishes what it finds.
  it('keeps a plan it already opened current when the watcher rediscovers it', () => {
    publish('.claude/plans/p.md');
    closeCanvasTab('task-1', 'markdown:.claude/plans/p.md');
    publish('.claude/plans/p.md', true);

    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'ExitPlanMode', prompt: 'permission' });
    expect(activePath()).toBe('.claude/plans/p.md');
  });

  // A resumed task already has the plan file on disk before the agent edits it.
  it('opens a rediscovered plan once the agent writes to it', () => {
    publish('docs/plans/resumed.md', true);
    expect(openPaths()).toBeUndefined();

    publish('docs/plans/resumed.md');
    expect(activePath()).toBe('docs/plans/resumed.md');
  });

  it('opens each plan once, so later edits leave the open tab alone', () => {
    publish('docs/plans/codex.md');
    closeCanvasTab('task-1', 'markdown:docs/plans/codex.md');
    publish('docs/plans/codex.md');
    expect(openPaths()).toBeUndefined();

    publish('docs/plans/second.md');
    expect(activePath()).toBe('docs/plans/second.md');
  });

  it('clears the plan when its file is deleted, and opens nothing afterwards', () => {
    publish('.claude/plans/p.md');
    publish(null);
    expect(store.tasks['task-1'].planContent).toBeUndefined();
    expect(store.tasks['task-1'].livePlanPath).toBeUndefined();

    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'ExitPlanMode', prompt: 'permission' });
    expect(openPaths()).toEqual(['.claude/plans/p.md']);
  });
});

describe('startCanvasAutoOpen with plans', () => {
  it('brings the current plan back to the front when Claude asks for approval', async () => {
    publish('.claude/plans/p.md');
    openCanvasDocument('task-1', 'docs/a.md');
    expect(activePath()).toBe('docs/a.md');

    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'ExitPlanMode', prompt: 'permission' });
    await flush();
    expect(openPaths()).toEqual(['.claude/plans/p.md', 'docs/a.md']);
    expect(activePath()).toBe('.claude/plans/p.md');
  });

  it('never opens a plan only found on disk, and never looks one up itself', async () => {
    publish('.claude/plans/leftover.md', true);
    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'ExitPlanMode', prompt: 'permission' });
    await flush();
    expect(openPaths()).toBeUndefined();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('does nothing on approval when no plan has arrived', async () => {
    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'ExitPlanMode', prompt: 'permission' });
    await flush();
    expect(openPaths()).toBeUndefined();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('leaves other tool prompts alone', async () => {
    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'Bash', prompt: 'permission' });
    await flush();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(openPaths()).toBeUndefined();
  });
});

describe('plans arriving from the watcher', () => {
  it("opens a Codex task's plan when its file appears", () => {
    setStore('agents', 'agent-1', agentFor('/usr/local/bin/codex'));
    publish('docs/plans/codex.md');
    expect(activePath()).toBe('docs/plans/codex.md');
  });

  it.each(['claude', 'codex'])(
    'opens a root plan written by %s without an approval hook',
    (command) => {
      setStore('agents', 'agent-1', agentFor(command));
      publish('example-plan.md');
      expect(activePath()).toBe('example-plan.md');

      closeTaskCanvas('task-1');
      publish('example-plan.md');
      expect(openPaths()).toBeUndefined();
    },
  );

  it('opens a Claude plan on arrival, even before its agent is restored', () => {
    publish('.claude/plans/early.md');
    expect(activePath()).toBe('.claude/plans/early.md');
    setStore('agents', 'agent-1', agentFor('claude'));
    publish('.claude/plans/c.md');
    expect(activePath()).toBe('.claude/plans/c.md');
  });
});

describe('canvas tabs', () => {
  it('opens files in tabs, once each, and switches between them', () => {
    openCanvasDocument('task-1', 'docs/a.md');
    openCanvasDocument('task-1', 'docs/b.md');
    openCanvasDocument('task-1', 'docs/a.md');
    expect(openPaths()).toEqual(['docs/a.md', 'docs/b.md']);
    expect(activePath()).toBe('docs/a.md');

    activateCanvasTab('task-1', 'markdown:docs/b.md');
    expect(activePath()).toBe('docs/b.md');
    activateCanvasTab('task-1', 'markdown:docs/nope.md');
    expect(activePath()).toBe('docs/b.md');
  });

  it('closing the last tab closes the column', () => {
    openCanvasDocument('task-1', 'docs/a.md');
    openCanvasDocument('task-1', 'docs/b.md');
    closeCanvasTab('task-1', 'markdown:docs/b.md');
    expect(store.tasks['task-1']).toMatchObject({
      canvasTabs: [md('docs/a.md')],
      canvasActiveTab: 'markdown:docs/a.md',
    });
    closeCanvasTab('task-1', 'markdown:docs/a.md');
    expect(store.tasks['task-1'].canvasTabs).toBeUndefined();
    expect(store.tasks['task-1'].canvasOpen).toBeUndefined();
  });
});

describe('task column width with the canvas', () => {
  const columnWidth = () => getPanelUserSize('tiling:task-1');

  it('grows the column by the canvas when it opens and gives it back on close', () => {
    openCanvasDocument('task-1', 'docs/a.md');
    expect(columnWidth()).toBe(520 + 400);

    // More tabs or re-opening must not grow it again.
    openCanvasDocument('task-1', 'docs/b.md');
    openTaskCanvas('task-1');
    expect(columnWidth()).toBe(520 + 400);

    closeCanvasTab('task-1', 'markdown:docs/a.md');
    expect(columnWidth()).toBe(520 + 400);
    closeCanvasTab('task-1', 'markdown:docs/b.md');
    expect(columnWidth()).toBe(520);
    closeTaskCanvas('task-1');
    expect(columnWidth()).toBe(520);
  });

  it('uses the width the user dragged the canvas to', () => {
    setPanelUserSize('tiling:task-1', 700);
    setPanelUserSize('task:task-1:canvas-cols:canvas', 450);
    openTaskCanvas('task-1');
    expect(columnWidth()).toBe(700 + 450);
    closeTaskCanvas('task-1');
    expect(columnWidth()).toBe(700);
  });

  it('never shrinks the column below its minimum', () => {
    setPanelUserSize('tiling:task-1', 400);
    setStore('tasks', 'task-1', 'canvasOpen', true);
    setPanelUserSize('task:task-1:canvas-cols:canvas', 900);
    closeTaskCanvas('task-1');
    expect(columnWidth()).toBe(300);
  });
});
