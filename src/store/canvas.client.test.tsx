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
  openArrivedPlan,
  openCanvasDocument,
  openTaskCanvas,
  startCanvasAutoOpen,
} from './canvas';
import { setPlanContent } from './tasks';
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

describe('startCanvasAutoOpen with plans', () => {
  it('opens the newest plan on the canvas when Claude asks for approval', async () => {
    vi.mocked(invoke).mockResolvedValue({
      content: '# Plan',
      fileName: 'p.md',
      relativePath: '.claude/plans/p.md',
    });
    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'ExitPlanMode', prompt: 'permission' });
    await flush();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.ReadPlanContent, {
      worktreePath: '/tmp/task',
    });
    expect(activePath()).toBe('.claude/plans/p.md');
  });

  it('adds the plan in front of a file the user had open, and does nothing without a plan', async () => {
    openCanvasDocument('task-1', 'docs/a.md');
    vi.mocked(invoke).mockResolvedValue(null);
    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'ExitPlanMode', prompt: 'permission' });
    await flush();
    expect(openPaths()).toEqual(['docs/a.md']);

    vi.mocked(invoke).mockResolvedValue({ relativePath: 'docs/plans/x.md' });
    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'ExitPlanMode', prompt: 'permission' });
    await flush();
    expect(openPaths()).toEqual(['docs/a.md', 'docs/plans/x.md']);
    expect(activePath()).toBe('docs/plans/x.md');
  });

  it('leaves other tool prompts alone', async () => {
    fire({ event: 'PreToolUse', state: 'waiting', toolName: 'Bash', prompt: 'permission' });
    await flush();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(openPaths()).toBeUndefined();
  });
});

describe('openArrivedPlan', () => {
  function planArrives(relativePath: string) {
    const previous = store.tasks['task-1'].planPath;
    setPlanContent('task-1', '# Plan', relativePath.split('/').pop() ?? '', relativePath);
    openArrivedPlan('task-1', previous);
  }

  it("opens a Codex task's plan when its file appears, once per file", () => {
    setStore('agents', 'agent-1', agentFor('/usr/local/bin/codex'));
    planArrives('docs/plans/codex.md');
    expect(activePath()).toBe('docs/plans/codex.md');

    closeCanvasTab('task-1', 'markdown:docs/plans/codex.md');
    planArrives('docs/plans/codex.md');
    expect(openPaths()).toBeUndefined();

    planArrives('docs/plans/second.md');
    expect(activePath()).toBe('docs/plans/second.md');
  });

  it.each(['claude', 'codex'])(
    'opens a root plan written by %s without an approval hook',
    (command) => {
      setStore('agents', 'agent-1', agentFor(command));
      planArrives('example-plan.md');
      expect(activePath()).toBe('example-plan.md');

      closeTaskCanvas('task-1');
      planArrives('example-plan.md');
      expect(openPaths()).toBeUndefined();
    },
  );

  it('opens a Claude plan on arrival, even before its agent is restored', () => {
    planArrives('.claude/plans/early.md');
    expect(activePath()).toBe('.claude/plans/early.md');
    setStore('agents', 'agent-1', agentFor('claude'));
    planArrives('.claude/plans/c.md');
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
    expect(columnWidth()).toBe(520 + 320);

    // More tabs or re-opening must not grow it again.
    openCanvasDocument('task-1', 'docs/b.md');
    openTaskCanvas('task-1');
    expect(columnWidth()).toBe(520 + 320);

    closeCanvasTab('task-1', 'markdown:docs/a.md');
    expect(columnWidth()).toBe(520 + 320);
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
