// Runs against the real store in the client (happy-dom) config;
// only IPC and saving are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { store, setStore } from './core';
import {
  activateCanvasTab,
  getTaskMindMap,
  replaceUnreadableMindMap,
  referenceCanvasNode,
  askCanvasBranch,
  setTaskMindMap,
  updateTaskMindMapFromAgent,
  setTaskReasoningProfile,
  closeCanvasTab,
  closeTaskCanvas,
  applyPlanContent,
  openCanvasDocument,
  openCanvasBrowser,
  appendBrowserReference,
  setTaskBrowserUrl,
  markBrowserFocused,
  openCanvasReasoning,
  openCanvasViewFromAgent,
  openTaskCanvas,
  setTaskReasoningWorkspace,
} from './canvas';
import { deletePanelUserSize, getPanelUserSize, setPanelUserSize } from './ui';
import { saveState } from './persistence';
import { registerFocusFn, unregisterFocusFn } from './focused-panel';
import type { Agent, Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./persistence')>()),
  saveState: vi.fn(async () => undefined),
}));

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
const openPaths = () =>
  store.tasks['task-1'].canvasTabs?.filter((t) => t.kind === 'markdown').map((t) => t.path);
const activePath = () => store.tasks['task-1'].canvasActiveTab?.replace('markdown:', '');

it('keeps only the current run workspace per task', () => {
  const workspace = { drafts: {} };
  setTaskReasoningWorkspace('task-1', 'task-1:agent-1:run-1', workspace);
  setTaskReasoningWorkspace('task-1', 'task-1:agent-1:run-2', workspace);
  expect(Object.keys(store.tasks['task-1'].reasoningWorkspaces ?? {})).toEqual([
    'task-1:agent-1:run-2',
  ]);
});

it('keeps workflow choices task-scoped without changing canvas tabs', () => {
  setStore('tasks', 'task-2', { ...task, id: 'task-2', reasoningProfile: 'research' });
  openCanvasReasoning('task-1');
  setTaskReasoningProfile('task-1', 'architecture');
  expect(store.tasks['task-1'].reasoningProfile).toBe('architecture');
  expect(store.tasks['task-2'].reasoningProfile).toBe('research');
  expect(store.tasks['task-1'].canvasActiveTab).toBe('reasoning');
  expect(store.tasks['task-1'].canvasTabs).toEqual([{ kind: 'reasoning' }]);
});

it('stages node references alongside the existing chat draft without sending terminal input', () => {
  setStore('tasks', 'task-1', { promptDraft: 'My question', prefillPrompt: undefined });
  const node = { id: 'node-1', title: 'Title\u001b\r', detail: 'Saved notes\nMore context' };
  referenceCanvasNode('task-1', 'mindmap', node, 3);
  referenceCanvasNode('task-1', 'reasoning', node, 5, 'run-1');
  const text = store.tasks['task-1'].prefillPrompt ?? '';
  expect(text.startsWith('My question')).toBe(true);
  expect(text).toContain('mindmap_read');
  expect(text).toContain('reasoning_read');
  expect(text).toContain('"runId":"run-1"');
  expect(text).toContain('"id":"node-1"');
  // Only the reasoning graph has a working marker; the mind map reference stays plain.
  const [mindmap, reasoning] = text.split('Node reference (reasoning):');
  expect(mindmap).not.toContain('activeId');
  expect(reasoning).toContain('Set activeId to this id while you work on it');
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('\r');
  expect(store.tasks['task-1'].promptDraftActive).toBe(true);
  expect(vi.mocked(invoke).mock.calls.some(([channel]) => channel === IPC.WriteToAgent)).toBe(
    false,
  );
  setStore('tasks', 'task-1', {
    promptDraft: undefined,
    prefillPrompt: undefined,
    promptDraftActive: undefined,
  });
});

it('stages a scoped branch request with saved context and preserves the existing draft', () => {
  setStore('tasks', 'task-1', { promptDraft: 'My existing question', prefillPrompt: undefined });
  const map = {
    records: [
      { id: 'root', title: 'Project', detail: '' },
      { id: 'branch', parent: 'root', title: 'Chosen topic', detail: 'Saved notes' },
      { id: 'child', parent: 'branch', title: 'Child idea', detail: 'Child notes' },
      { id: 'other', parent: 'root', title: 'Unrelated topic', detail: 'Private unrelated notes' },
    ],
    relations: [{ id: 'link', source: 'child', target: 'other', kind: 'supports' }],
  };
  askCanvasBranch(
    'task-1',
    'reasoning',
    { intent: 'investigate', rootId: 'branch', map, revision: 7 },
    'run-2',
  );
  const prompt = store.tasks['task-1'].prefillPrompt ?? '';
  expect(prompt.startsWith('My existing question')).toBe(true);
  expect(prompt).toContain('Investigate the claims');
  const context = JSON.parse(prompt.split('\n').find((line) => line.startsWith('{')) ?? '{}');
  expect(context).toMatchObject({
    rootId: 'branch',
    revision: 7,
    runId: 'run-2',
    ancestors: [{ id: 'root', title: 'Project' }],
    omittedNodes: 0,
  });
  expect(context.nodes.map((node: { id: string }) => node.id)).toEqual(['branch', 'child']);
  expect(context.nodes[0].detail).toBe('Saved notes');
  expect(context.relations).toEqual(map.relations);
  expect(prompt).not.toContain('Private unrelated notes');
  expect(prompt).toContain('reasoning_read');
  expect(prompt).toContain('reasoning_update');
  expect(prompt).toContain('Otherwise, suggest additions in chat');
  expect(store.tasks['task-1'].promptDraftActive).toBe(true);
  expect(store.showPromptInput).toBe(true);
  expect(vi.mocked(invoke).mock.calls.some(([channel]) => channel === IPC.WriteToAgent)).toBe(
    false,
  );
});

beforeEach(() => {
  setStore('tasks', 'task-1', { ...task });
});

afterEach(() => {
  setStore('tasks', 'task-1', {
    canvasTabs: undefined,
    canvasActiveTab: undefined,
    canvasOpen: undefined,
    reasoningCanvasRequest: undefined,
    planPath: undefined,
    mindMap: undefined,
    mindMapUnreadable: undefined,
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

const publish = (relativePath: string | null, recovered?: boolean) =>
  applyPlanContent({
    taskId: 'task-1',
    content: relativePath && '# Plan',
    fileName: relativePath?.split('/').at(-1) ?? null,
    relativePath,
    recovered,
  });

describe('applyPlanContent', () => {
  it.each([false, true])(
    'updates plan content without opening the canvas (recovered: %s)',
    (recovered) => {
      publish('docs/plans/plan.md', recovered);
      expect(store.tasks['task-1'].planContent).toBe('# Plan');
      expect(store.tasks['task-1'].planPath).toBe('docs/plans/plan.md');
      expect(openPaths()).toBeUndefined();
      expect(store.tasks['task-1'].canvasOpen).toBeUndefined();
      expect(getPanelUserSize('tiling:task-1')).toBeUndefined();
    },
  );

  it('leaves the active reasoning graph and its tabs alone', () => {
    openCanvasReasoning('task-1');
    publish('docs/plans/investigation.md');
    expect(store.tasks['task-1'].canvasActiveTab).toBe('reasoning');
    expect(store.tasks['task-1'].canvasTabs).toEqual([{ kind: 'reasoning' }]);
  });

  it('keeps manually opened documents selected and does not reopen a closed canvas', () => {
    publish('docs/plans/plan.md');
    openCanvasDocument('task-1', 'docs/plans/plan.md');
    openCanvasDocument('task-1', 'notes.md');
    publish('docs/plans/second.md');
    expect(activePath()).toBe('notes.md');
    expect(openPaths()).toEqual(['docs/plans/plan.md', 'notes.md']);

    closeTaskCanvas('task-1');
    publish('docs/plans/second.md');
    publish('docs/plans/third.md');
    expect(openPaths()).toBeUndefined();
    expect(store.tasks['task-1'].canvasOpen).toBeUndefined();
  });

  it('clears the plan when its file is deleted', () => {
    publish('docs/plans/plan.md');
    publish(null);
    expect(store.tasks['task-1'].planContent).toBeUndefined();
    expect(store.tasks['task-1'].planPath).toBeUndefined();
    expect(openPaths()).toBeUndefined();
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

  it('closing the last tab closes the column', async () => {
    const focusAgent = vi.fn();
    setStore('activeTaskId', 'task-1');
    setStore('focusedPanel', 'task-1', 'canvas');
    registerFocusFn('task-1:ai-terminal:agent-1', focusAgent);
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
    expect(store.focusedPanel['task-1']).toBe('ai-terminal:agent-1');
    // Focus is applied on a microtask so batched selection changes coalesce.
    await Promise.resolve();
    expect(focusAgent).toHaveBeenCalledOnce();
    unregisterFocusFn('task-1:ai-terminal:agent-1');
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

it('lets agents open either canvas view for a live task without touching content', () => {
  setStore('agents', 'agent-1', agentFor('codex'));
  openCanvasViewFromAgent('task-1', { view: 'reasoning' });
  expect(store.tasks['task-1'].canvasActiveTab).toBe('reasoning');
  expect(store.tasks['task-1'].reasoningCanvasRequest).toEqual({
    agentId: 'agent-1',
    generation: 0,
  });
  openCanvasViewFromAgent('task-1', { view: 'mindmap' });
  expect(store.tasks['task-1'].canvasTabs).toEqual([{ kind: 'reasoning' }, { kind: 'mindmap' }]);
  expect(store.tasks['task-1'].canvasActiveTab).toBe('mindmap');
  expect(store.tasks['task-1'].mindMap).toBeUndefined();
  expect(() => openCanvasViewFromAgent('task-1', { view: 'browser' })).toThrow(
    'mindmap, reasoning',
  );
  expect(() => openCanvasViewFromAgent('missing', { view: 'mindmap' })).toThrow(
    'Task not available',
  );
  setStore('tasks', 'task-1', 'closingStatus', 'closing');
  expect(() => openCanvasViewFromAgent('task-1', { view: 'mindmap' })).toThrow(
    'Task not available',
  );
  setStore('tasks', 'task-1', 'closingStatus', undefined);
});

it('opens one reasoning tab alongside documents and returns to the document when closed', () => {
  openCanvasDocument('task-1', 'notes.md');
  openCanvasReasoning('task-1');
  openCanvasReasoning('task-1');
  expect(store.tasks['task-1'].canvasTabs).toEqual([md('notes.md'), { kind: 'reasoning' }]);
  expect(store.tasks['task-1'].canvasActiveTab).toBe('reasoning');
  closeCanvasTab('task-1', 'reasoning');
  expect(store.tasks['task-1'].canvasActiveTab).toBe('markdown:notes.md');
});

it('shares the same persisted root with agents and rejects stale writes after a manual edit', async () => {
  const first = getTaskMindMap('task-1');
  expect(getTaskMindMap('task-1')).toEqual(first);
  const root = first.records[0].id;
  const next = await updateTaskMindMapFromAgent('task-1', {
    expectedRevision: 0,
    operations: [
      { type: 'update', id: root, changes: { title: 'Project overview' } },
      {
        type: 'insert',
        node: { id: 'ui', parent: root, title: 'User interface', detail: 'Views and canvas' },
      },
    ],
  });
  expect(store.tasks['task-1'].mindMap).toEqual(next);
  expect(store.tasks['task-1'].canvasActiveTab).toBe('mindmap');
  setTaskMindMap('task-1', {
    ...next,
    revision: 2,
    records: next.records.map((node) =>
      node.id === 'ui' ? { ...node, title: 'My UI title' } : node,
    ),
  });
  const update = {
    expectedRevision: 1,
    operations: [{ type: 'update', id: 'ui', changes: { title: 'Stale title' } }],
  };
  await expect(updateTaskMindMapFromAgent('task-1', update)).rejects.toThrow('Read it again');
  expect(getTaskMindMap('task-1').records[1].title).toBe('My UI title');
  expect(next.records[1].title).toBe('User interface');
});

it('serializes competing agent writes and leaves the selected canvas tab alone after initial publication', async () => {
  const map = getTaskMindMap('task-1');
  const update = {
    expectedRevision: 0,
    operations: [{ type: 'update', id: map.records[0].id, changes: { title: 'First' } }],
  };
  const results = await Promise.allSettled([
    updateTaskMindMapFromAgent('task-1', update),
    updateTaskMindMapFromAgent('task-1', update),
  ]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  openCanvasReasoning('task-1');
  await updateTaskMindMapFromAgent('task-1', { ...update, expectedRevision: 1 });
  expect(store.tasks['task-1'].canvasActiveTab).toBe('reasoning');
  expect(() => getTaskMindMap('__proto__')).toThrow('Task not available');
  await expect(updateTaskMindMapFromAgent('missing', update)).rejects.toThrow();
});

it('keeps an unreadable saved map until the user replaces it', () => {
  setStore('tasks', 'task-1', { mindMap: undefined, mindMapUnreadable: { version: 99 } });
  expect(() => getTaskMindMap('task-1')).toThrow('could not be read');
  expect(store.tasks['task-1'].mindMapUnreadable).toEqual({ version: 99 });
  replaceUnreadableMindMap('task-1');
  expect(store.tasks['task-1'].mindMapUnreadable).toBeUndefined();
  expect(getTaskMindMap('task-1').records).toHaveLength(1);
});

describe('browser canvas', () => {
  it('opens a single browser beside existing documents', () => {
    openCanvasDocument('task-1', 'README.md');
    openCanvasBrowser('task-1');
    openCanvasBrowser('task-1');
    expect(store.tasks['task-1'].canvasTabs).toEqual([
      md('README.md'),
      { kind: 'browser', path: 'preview' },
    ]);
    expect(store.tasks['task-1'].canvasActiveTab).toBe('browser:preview');
  });
  it('updates URLs without writing the workspace for every history event', () => {
    vi.mocked(saveState).mockClear();
    setTaskBrowserUrl('task-1', 'http://localhost:3000/#one');
    setTaskBrowserUrl('task-1', 'http://localhost:3000/#two');
    expect(store.tasks['task-1'].browserUrl).toBe('http://localhost:3000/#two');
    expect(saveState).not.toHaveBeenCalled();
  });
  it('activates the browser task and canvas without invoking DOM focus', () => {
    const focus = vi.fn();
    registerFocusFn('task-1:canvas', focus);
    const previous = {
      activeTaskId: store.activeTaskId,
      activeAgentId: store.activeAgentId,
      sidebarFocused: store.sidebarFocused,
      placeholderFocused: store.placeholderFocused,
      focusedPanel: store.focusedPanel['task-1'],
    };
    try {
      setStore('activeTaskId', 'another-task');
      setStore('sidebarFocused', true);
      markBrowserFocused('task-1');
      expect(store.activeTaskId).toBe('task-1');
      expect(store.focusedPanel['task-1']).toBe('canvas');
      expect(store.sidebarFocused).toBe(false);
      expect(store.placeholderFocused).toBe(false);
      expect(focus).not.toHaveBeenCalled();
    } finally {
      unregisterFocusFn('task-1:canvas');
      setStore('activeTaskId', previous.activeTaskId);
      setStore('activeAgentId', previous.activeAgentId);
      setStore('sidebarFocused', previous.sidebarFocused);
      setStore('placeholderFocused', previous.placeholderFocused);
      setStore('focusedPanel', 'task-1', previous.focusedPanel);
    }
  });
  it('appends references to the unsent draft and makes the prompt visible', () => {
    setStore('tasks', 'task-1', { promptDraft: 'Make this smaller', prefillPrompt: undefined });
    setStore('showPromptInput', false);
    appendBrowserReference('task-1', 'Selected element #save');
    appendBrowserReference('task-1', 'Selected element #cancel');
    expect(store.tasks['task-1'].prefillPrompt).toBe(
      'Make this smaller\n\nSelected element #save\n\nSelected element #cancel',
    );
    expect(store.tasks['task-1'].promptDraftActive).toBe(true);
    expect(store.showPromptInput).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith(IPC.WriteToAgent, expect.anything());
  });
});
