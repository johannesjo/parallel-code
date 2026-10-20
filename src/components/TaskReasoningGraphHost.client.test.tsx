import { createSignal, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskReasoningGraphHost } from './TaskReasoningGraphHost';
import { commitTaskReasoningEdit } from '../store/reasoning';
import { acceptUpdate } from '../investigation/state';
import { parseReasoningFeed } from '../investigation/feed';
import { invoke } from '../lib/ipc';
import { openFileInEditor } from '../lib/shell';
import { openCanvasDocument } from '../store/canvas';
import { IPC } from '../../electron/ipc/channels';
import {
  store,
  sendPrompt,
  isAgentIdle,
  isAgentAskingQuestion,
  markTaskUserActivity,
  setTaskReasoningProfile,
  setTaskReasoningWorkspace,
  saveState,
  restartAgent,
  showNotification,
} from '../store/store';
import type { ReasoningProfile } from '../investigation/profiles';
import type { ReasoningWorkspace } from '../investigation/editing';
import { makeFixture } from '../investigation/fixture';
import { expectDefined } from '../store/test-helpers';
import { recordAgentPublication } from '../store/reasoning-activity';
import { getAgentHookStatus } from '../store/agentHookStatus';
import type { AgentHookStatusState } from '../../electron/agent-hooks/status';

const { resetWorkspace, setCanvasTools, setAgentStatus, requestCanvas, agentIdle, setIdle } =
  vi.hoisted(() => ({
    resetWorkspace: vi.fn<() => void>(),
    setCanvasTools: vi.fn<(available: boolean | undefined) => void>(),
    setAgentStatus: vi.fn<(status: 'running' | 'exited') => void>(),
    requestCanvas: vi.fn<() => void>(),
    // Idleness is a signal, as in the real store, so the host reacts to it without polling.
    agentIdle: vi.fn<() => boolean>(),
    setIdle: vi.fn<(idle: boolean) => void>(),
  }));

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../lib/shell', () => ({ openFileInEditor: vi.fn(async () => {}) }));
vi.mock('../store/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/canvas')>()),
  openCanvasDocument: vi.fn(),
}));
vi.mock('../store/reasoning', () => ({ commitTaskReasoningEdit: vi.fn() }));
vi.mock('../store/agentHookStatus', () => ({ getAgentHookStatus: vi.fn(() => null) }));
// The activation input reads the store modules directly; point them at the mocked store.
vi.mock('../store/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/core')>()),
  store: (await import('../store/store')).store,
}));
vi.mock('../store/taskStatus', async (importOriginal) => {
  const mocked = await import('../store/store');
  return {
    ...(await importOriginal<typeof import('../store/taskStatus')>()),
    isAgentIdle: mocked.isAgentIdle,
    isAgentAskingQuestion: mocked.isAgentAskingQuestion,
  };
});
vi.mock('../store/store', () => {
  const [idle, setIdleSignal] = createSignal(true);
  // eslint-disable-next-line solid/reactivity -- the host tracks this signal through isAgentIdle
  agentIdle.mockImplementation(idle);
  setIdle.mockImplementation(setIdleSignal);
  const [store, setStore] = createStore({
    focusMode: false,
    tasks: {
      task: {
        id: 'task',
        worktreePath: '/task',
        agentIds: ['agent'],
        promptDraft: 'Keep my draft',
        reasoningProfile: 'investigation' as ReasoningProfile,
        reasoningCanvasRequest: undefined as { agentId: string; generation: number } | undefined,
        reasoningWorkspaces: undefined as Record<string, ReasoningWorkspace> | undefined,
      },
    },
    agents: {
      agent: {
        status: 'running' as 'running' | 'exited',
        canvasTools: true as boolean | undefined,
        generation: 0,
        def: { name: 'Test agent' },
      },
    },
  });
  setCanvasTools.mockImplementation((available) =>
    setStore('agents', 'agent', 'canvasTools', available),
  );
  requestCanvas.mockImplementation(() =>
    setStore('tasks', 'task', 'reasoningCanvasRequest', {
      agentId: 'agent',
      generation: untrack(() => store.agents.agent.generation),
    }),
  );
  setAgentStatus.mockImplementation((status) => {
    setStore('agents', 'agent', 'status', status);
    // Restarts keep the agent ID and bump the generation, as the real store does.
    if (status === 'running') setStore('agents', 'agent', 'generation', (value) => value + 1);
  });
  resetWorkspace.mockImplementation(() =>
    setStore('tasks', 'task', 'reasoningWorkspaces', undefined),
  );
  return {
    store,
    saveState: vi.fn(async () => {}),
    setTaskReasoningWorkspace: vi.fn(
      (taskId: string, key: string, workspace: ReasoningWorkspace) => {
        if (taskId === 'task')
          setStore('tasks', 'task', 'reasoningWorkspaces', (before) => ({
            ...before,
            [key]: workspace,
          }));
      },
    ),
    setTaskReasoningProfile: vi.fn((taskId: string, profile: ReasoningProfile) => {
      if (taskId === 'task') setStore('tasks', 'task', 'reasoningProfile', profile);
    }),
    sendPrompt: vi.fn(),
    // A restart respawns with unknown tools, as the real store does.
    restartAgent: vi.fn(() => {
      setAgentStatus('running');
      setCanvasTools(undefined);
    }),
    markTaskUserActivity: vi.fn(),
    showNotification: vi.fn(),
    isAgentIdle: vi.fn(() => agentIdle()),
    isAgentAskingQuestion: vi.fn(() => false),
  };
});
let dispose: (() => void) | undefined;
let container: HTMLDivElement;
const encode = (count: number) =>
  makeFixture()
    .updates.slice(0, count)
    .map((u) => JSON.stringify(u))
    .join('\n') + '\n';
/** What the main process returns for a feed read; the stamp only needs to follow the text. */
const feed = (raw: string | null) => (raw === null ? null : { raw, stamp: String(raw.length) });
beforeEach(() => {
  vi.useFakeTimers();
  setTaskReasoningProfile('task', 'investigation');
  resetWorkspace();
  setAgentStatus('running');
  setCanvasTools(true);
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(sendPrompt).mockResolvedValue(undefined);
  vi.mocked(isAgentIdle).mockImplementation(() => agentIdle());
  setIdle(true);
  vi.mocked(isAgentAskingQuestion).mockReturnValue(false);
  vi.mocked(getAgentHookStatus).mockReturnValue(null);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});
function mount() {
  const [visible, setVisible] = createSignal(true);
  const [taskId, setTaskId] = createSignal('task');
  dispose = render(
    () => <TaskReasoningGraphHost taskId={taskId()} visible={visible()} />,
    container,
  );
  return { setVisible, setTaskId };
}
function chooseWorkflow(profile: string) {
  const radio = expectDefined(
    container.querySelector<HTMLInputElement>(`input[type="radio"][value="${profile}"]`),
  );
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}
const statusPill = () =>
  expectDefined(container.querySelector<HTMLButtonElement>('.task-reasoning-status'));
/** Opens the pill's disclosure once and reads the details it reveals. */
function statusDetails() {
  if (statusPill().getAttribute('aria-expanded') !== 'true') statusPill().click();
  return container.querySelector('.task-reasoning-status-details')?.textContent ?? '';
}
function button(text: string) {
  return expectDefined(
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(text) || b.getAttribute('aria-label') === text,
    ),
  );
}
/** Dialogs render through a portal outside the host container. */
function documentButton(text: string) {
  const scope = document.querySelector('[role="dialog"]') ?? document;
  return expectDefined(
    [...scope.querySelectorAll('button')].find((b) => b.textContent?.includes(text)),
  );
}

it('offers no expand action in the map navigation', async () => {
  vi.mocked(invoke).mockResolvedValue(feed(encode(2)));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  const navigation = expectDefined(container.querySelector('[aria-label="Map navigation"]'));
  expect(navigation.querySelector('[title="Expand reasoning view"]')).toBeNull();
  for (const label of ['Fit map', 'Find current']) {
    const control = expectDefined(navigation.querySelector(`[aria-label="${label}"]`));
    expect(
      control.querySelector('.investigation-navigation-icon[aria-hidden="true"]'),
    ).not.toBeNull();
    expect(control.querySelector('.investigation-navigation-label')?.textContent).toBe(label);
    expect(control.getAttribute('title')).toBeTruthy();
  }
});

it('updates the working badge from live activity without requiring a new graph revision', async () => {
  const [idle, setIdle] = createSignal(true);
  // eslint-disable-next-line solid/reactivity -- the component tracks this mock's signal read
  vi.mocked(isAgentIdle).mockImplementation(idle);
  vi.mocked(invoke).mockResolvedValue(feed(encode(8)));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  const badge = () => expectDefined(container.querySelector('.investigation-working-label'));
  const node = badge().closest('.investigation-node-shell');
  expect(badge().textContent).toContain('Worked on last');
  expect(badge().getAttribute('data-working')).toBe('false');
  setIdle(false);
  expect(badge().textContent).toContain('Working now');
  expect(badge().getAttribute('data-working')).toBe('true');
  setIdle(true);
  expect(badge().textContent).toContain('Worked on last');
  expect(node?.querySelector('[data-record-id]')?.getAttribute('aria-label')).not.toContain(
    'Working now',
  );
  setIdle(false);
  setAgentStatus('exited');
  expect(badge().getAttribute('data-working')).toBe('false');
  expect(badge().closest('.investigation-node-shell')).toBe(node);
  expect(commitTaskReasoningEdit).not.toHaveBeenCalled();
  expect(setTaskReasoningWorkspace).not.toHaveBeenCalled();
});

it('uses hook activity over terminal heuristics and downgrades waiting or finished turns immediately', async () => {
  const [hook, setHook] = createSignal<AgentHookStatusState>('working');
  // eslint-disable-next-line solid/reactivity -- the component tracks this mock's signal read
  vi.mocked(getAgentHookStatus).mockImplementation(() => ({
    state: hook(),
    event: 'test',
    since: 0,
    updatedAt: 0,
    unread: false,
  }));
  // Quiet output and question-like text must not override a working hook.
  setIdle(true);
  vi.mocked(isAgentAskingQuestion).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue(feed(encode(8)));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  const badge = () => expectDefined(container.querySelector('.investigation-working-label'));
  expect(badge().textContent).toContain('Working now');
  setHook('waiting');
  expect(badge().textContent).toContain('Worked on last');
  // Prompt redraws can continue producing output after Stop.
  setIdle(false);
  vi.mocked(isAgentAskingQuestion).mockReturnValue(false);
  setHook('done');
  expect(badge().getAttribute('data-working')).toBe('false');
  setHook('working');
  expect(badge().getAttribute('data-working')).toBe('true');
});

it('does not mark a terminal question as work when hooks are unavailable', async () => {
  setIdle(false);
  vi.mocked(isAgentAskingQuestion).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue(feed(encode(8)));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector('.investigation-working-label')?.textContent).toContain(
    'Worked on last',
  );
});

it('confirms starting a new map with the chosen workflow', async () => {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(encode(2)) : null,
  );
  mount();
  await vi.advanceTimersByTimeAsync(0);
  const node = container.querySelector('[data-record-id="H1"]');
  expect(node).not.toBeNull();
  expect(container.querySelector('input[type="radio"]')).toBeNull();
  expect(statusDetails()).toContain('Report from Test agent · Revision 2 · not live');
  button('New map…').click();
  chooseWorkflow('architecture');
  expect(setTaskReasoningProfile).toHaveBeenCalledWith('task', 'architecture');
  expect(container.querySelector('[data-record-id="H1"]')).toBe(node);
  expect(sendPrompt).not.toHaveBeenCalled();
  button('New map…').click();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New map?');
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(restartAgent).not.toHaveBeenCalled();
  documentButton('New map').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).toHaveBeenCalledWith(
    'task',
    'agent',
    expect.stringContaining('Workflow: Architecture.'),
    { appPrompt: true },
  );
  expect(vi.mocked(sendPrompt).mock.calls[0][2]).toContain('supply a distinct newRunId');
  expect(restartAgent).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="radio"]')).toBeNull();
  expect(statusDetails()).toContain('Waiting for first update');
  button('New map…').click();
  chooseWorkflow('research');
  button('Cancel').click();
  expect(container.querySelector('input[type="radio"]')).toBeNull();
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'cancels a new map without changing the current map or restarting the agent (restart: %s)',
  async (restartFirst) => {
    vi.mocked(invoke).mockImplementation(async (channel) =>
      channel === IPC.ReadReasoningFeed ? feed(encode(2)) : null,
    );
    mount();
    await vi.advanceTimersByTimeAsync(0);
    const node = container.querySelector('[data-record-id="H1"]');
    button('New map…').click();
    const restart = expectDefined(
      container.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    );
    restart.checked = restartFirst;
    restart.dispatchEvent(new Event('change', { bubbles: true }));
    button('New map…').click();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('will be archived');
    documentButton('Cancel').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(restartAgent).not.toHaveBeenCalled();
    expect(
      vi.mocked(invoke).mock.calls.some(([channel]) => channel === IPC.PrepareReasoningFeed),
    ).toBe(false);
    expect(container.querySelector('[data-record-id="H1"]')).toBe(node);
    button('Cancel').click();
    expect(container.querySelector('.reasoning-setup-overlay')).toBeNull();
  },
);

it('restarts the agent first when asked and sends once its tools are back', async () => {
  mount();
  await vi.advanceTimersByTimeAsync(0);
  const restart = expectDefined(
    container.querySelector<HTMLInputElement>('input[type="checkbox"]'),
  );
  restart.checked = true;
  restart.dispatchEvent(new Event('change', { bubbles: true }));
  setAgentStatus('exited');
  expect(button('Start live map').disabled).toBe(false);
  button('Start live map').click();
  expect(restartAgent).not.toHaveBeenCalled();
  documentButton('Restart and start').click();
  expect(restartAgent).toHaveBeenCalledWith('agent', false);
  expect(container.textContent).toContain('Queued until the agent is ready');
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendPrompt).not.toHaveBeenCalled();
  setCanvasTools(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendPrompt).toHaveBeenCalledOnce();
  expect(sendPrompt).toHaveBeenLastCalledWith(
    'task',
    'agent',
    expect.stringContaining('Continue the runId'),
    { appPrompt: true },
  );
  expect(statusDetails()).toContain('Waiting for first update');
});

it('cancels a pending connection if the task profile changes during preparation', async () => {
  let finish!: () => void;
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.PrepareReasoningFeed)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return null;
  });
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  setTaskReasoningProfile('task', 'research');
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('connects the composer agent only on request without touching the prompt draft', async () => {
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).not.toHaveBeenCalled();
  button('Start live map').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(invoke).toHaveBeenCalledWith(IPC.PrepareReasoningFeed, {
    taskId: 'task',
    agentId: 'agent',
    worktreePath: '/task',
  });
  expect(sendPrompt).toHaveBeenCalledWith(
    'task',
    'agent',
    expect.stringContaining('reasoning_update'),
    { appPrompt: true },
  );
  expect(store.tasks.task.promptDraft).toBe('Keep my draft');
  expect(statusDetails()).toContain('Waiting for first update');
});

it('does not send into a busy agent or after preparation fails', async () => {
  setIdle(false);
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  expect(container.textContent).toContain('Queued until the agent is ready');
  expect(sendPrompt).not.toHaveBeenCalled();
  dispose?.();
  setIdle(true);
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.PrepareReasoningFeed) throw new Error('Read-only worktree');
    return null;
  });
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Read-only worktree');
});

it('queues activation while busy and sends exactly once when idle', async () => {
  setIdle(false);
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Queued until the agent is ready');
  setIdle(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendPrompt).toHaveBeenCalledOnce();
  expect(store.tasks.task.promptDraft).toBe('Keep my draft');
  expect(statusDetails()).toContain('Waiting for first update');
});

it('cancels queued activation without sending later', async () => {
  setIdle(false);
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  button('Cancel').click();
  setIdle(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(button('Start live map')).toBeDefined();
});

it('confirms activation only after a new report arrives', async () => {
  let raw = encode(2);
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(raw) : null,
  );
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Resume live map').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusDetails()).toContain('Waiting for first update');
  expect(statusDetails()).not.toContain('Live · Test agent');
  raw = encode(3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(statusDetails()).toContain('Live · Test agent · Revision');
});

it('treats a report the agent published from chat as live without the activation button', async () => {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(encode(1)) : null,
  );
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(button('Resume live map')).toBeDefined();
  recordAgentPublication({ taskId: 'task', agentId: 'agent', generation: 99 });
  expect(statusDetails()).not.toContain('Live · Test agent');
  recordAgentPublication({
    taskId: 'task',
    agentId: 'agent',
    generation: store.agents.agent.generation,
  });
  expect(statusDetails()).toContain('Live · Test agent · Revision');
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
    'Resume live map',
  );
  expect(sendPrompt).not.toHaveBeenCalled();
  setAgentStatus('exited');
  setAgentStatus('running');
  expect(statusDetails()).not.toContain('Live · Test agent');
  expect(button('Resume live map').disabled).toBe(false);
});

it('keeps each task’s publication so a panel mounted later sees its own', async () => {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(encode(1)) : null,
  );
  recordAgentPublication({
    taskId: 'task',
    agentId: 'agent',
    generation: store.agents.agent.generation,
  });
  recordAgentPublication({ taskId: 'other', agentId: 'agent', generation: 0 });
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusDetails()).toContain('Live · Test agent · Revision');
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('skips workflow setup for an agent-opened graph and waits for its report without sending a prompt', async () => {
  let raw: string | null = null;
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(raw) : null,
  );
  requestCanvas();
  mount();
  expect(container.querySelector('.reasoning-graph-empty .inline-spinner')).not.toBeNull();
  expect(statusPill().textContent).toBe('Loading…');
  await vi.advanceTimersByTimeAsync(0);
  expect(statusPill().textContent).toBe('Connecting…');
  expect(container.querySelector('input[type="radio"]')).toBeNull();
  expect(container.textContent).toContain('Waiting for the agent’s first update');
  expect(container.querySelector('.reasoning-graph-empty')?.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('.investigation-svg')).toBeNull();
  expect(container.querySelector<HTMLFieldSetElement>('.reasoning-graph-actions')?.disabled).toBe(
    true,
  );
  expect(container.textContent).not.toContain('Current snapshot');
  expect(statusDetails()).not.toContain('Revision undefined');
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(
    vi.mocked(invoke).mock.calls.some(([channel]) => channel === IPC.PrepareReasoningFeed),
  ).toBe(false);
  raw = encode(1);
  recordAgentPublication({
    taskId: 'task',
    agentId: 'agent',
    generation: store.agents.agent.generation,
  });
  expect(container.querySelector('.reasoning-graph-empty .inline-spinner')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(container.querySelector('input[type="radio"]')).toBeNull();
  expect(statusPill().getAttribute('aria-expanded')).toBe('true');
  expect(statusPill().textContent).toBe('Live');
  expect(statusDetails()).toContain('Live · Test agent · Revision 1');
  expect(container.querySelector('.reasoning-graph-empty')).toBeNull();
  expect(container.querySelector('.investigation-svg')).not.toBeNull();
  expect(container.querySelector<HTMLFieldSetElement>('.reasoning-graph-actions')?.disabled).toBe(
    false,
  );
  expect(sendPrompt).not.toHaveBeenCalled();
  // A quiet feed turns the pill idle after ten minutes; the details keep the last revision.
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(statusPill().textContent).toMatch(/^Idle · \d+ m$/);
  expect(statusDetails()).toContain('Live · idle');
});

it('closes the status details when their source goes away', async () => {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(null) : null,
  );
  requestCanvas();
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusDetails()).toContain('Waiting for the agent’s first update');
  expect(statusPill().getAttribute('aria-expanded')).toBe('true');
  // The agent exits before its first report: nothing is left to disclose.
  setAgentStatus('exited');
  expect(statusPill().disabled).toBe(true);
  expect(statusPill().getAttribute('aria-expanded')).toBe('false');
  expect(statusPill().getAttribute('title')).toBeNull();
  expect(container.querySelector('.task-reasoning-status-details')).toBeNull();
});

it('grays out an agent-opened graph only until its first nodes arrive', async () => {
  const [idle, setIdle] = createSignal(false);
  // eslint-disable-next-line solid/reactivity -- the component tracks this mock's signal read
  vi.mocked(isAgentIdle).mockImplementation(idle);
  let raw = '';
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(raw) : null,
  );
  requestCanvas();
  mount();
  await vi.advanceTimersByTimeAsync(0);
  const drafting = () => container.querySelector('.reasoning-graph')?.getAttribute('data-drafting');
  expect(drafting()).toBe('true');
  expect(statusPill().textContent).toBe('Building…');
  expect(statusDetails()).toContain('Live · Test agent · building the first map…');
  expect(statusDetails()).not.toContain('Revision');
  raw = encode(1);
  recordAgentPublication({
    taskId: 'task',
    agentId: 'agent',
    generation: store.agents.agent.generation,
  });
  await vi.advanceTimersByTimeAsync(1000);
  // The first report can take minutes; readers get the map as soon as it has nodes.
  expect(container.querySelector('.investigation-svg')).not.toBeNull();
  expect(drafting()).toBe('false');
  expect(statusDetails()).not.toContain('building the first map');
  expect(statusDetails()).toContain('Live · Test agent · Revision 1');
  // Later turns are ordinary live work on a map the user can already read.
  setIdle(true);
  setIdle(false);
  expect(drafting()).toBe('false');
  // A new session that reopens the existing report is not writing a first draft either.
  setAgentStatus('exited');
  setAgentStatus('running');
  setCanvasTools(true);
  requestCanvas();
  expect(drafting()).toBe('false');
});

it('does not gray out an existing report the agent merely opened', async () => {
  setIdle(false);
  vi.mocked(invoke).mockResolvedValue(feed(encode(3)));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  requestCanvas();
  expect(container.querySelector('.investigation-svg')).not.toBeNull();
  expect(container.querySelector('.reasoning-graph')?.getAttribute('data-drafting')).toBe('false');
  expect(statusDetails()).not.toContain('building the first map');
});

it('shows feed errors instead of an endless loading spinner and recovers on a valid update', async () => {
  requestCanvas();
  vi.mocked(invoke).mockRejectedValue(new Error('Cannot read graph'));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector('.inline-spinner')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Cannot read graph');
  expect(container.querySelector<HTMLFieldSetElement>('.reasoning-graph-actions')?.disabled).toBe(
    true,
  );
  vi.mocked(invoke).mockResolvedValue(feed(encode(1)));
  await vi.advanceTimersByTimeAsync(1000);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('.investigation-svg')).not.toBeNull();
});

it('shows map actions directly in the toolbar and connection notices below it', async () => {
  vi.mocked(invoke).mockResolvedValue(feed(encode(1)));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  const toolbar = expectDefined(container.querySelector('[aria-label="Graph controls"]'));
  expect(toolbar.contains(button('Resume live map'))).toBe(false);
  expect(toolbar.textContent).toContain('Saved');
  expect(toolbar.textContent).not.toContain('Revision');
  expect(toolbar.contains(button('New map…'))).toBe(true);
  expect(toolbar.contains(button('Export graph'))).toBe(true);
  expect(toolbar.querySelector('[aria-label="More graph actions"]')).toBeNull();
  expect(button('Undo').querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(button('Redo').querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  button('New map…').click();
  expect(container.querySelector('.reasoning-graph-frame')?.hasAttribute('inert')).toBe(true);
  expect(container.querySelector<HTMLFieldSetElement>('.reasoning-graph-actions')?.disabled).toBe(
    true,
  );
  button('Cancel').click();
  expect(container.querySelector('.reasoning-setup-overlay')).toBeNull();
  expect(container.querySelector<HTMLFieldSetElement>('.reasoning-graph-actions')?.disabled).toBe(
    false,
  );
});

it('restores setup when the agent exits and does not reuse its open request after restart', async () => {
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector('input[type="radio"]')).not.toBeNull();
  requestCanvas();
  expect(container.querySelector('input[type="radio"]')).toBeNull();
  setAgentStatus('exited');
  expect(container.querySelector('input[type="radio"]')).not.toBeNull();
  setAgentStatus('running');
  expect(container.querySelector('input[type="radio"]')).not.toBeNull();
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('claims the manual input hold before preparing and sending a connection prompt', async () => {
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.PrepareReasoningFeed)
      expect(markTaskUserActivity).toHaveBeenCalledWith('task');
    return null;
  });
  vi.mocked(sendPrompt).mockImplementation(async () => {
    expect(markTaskUserActivity).toHaveBeenCalledWith('task');
  });
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).toHaveBeenCalledOnce();
});

it('reads live reports and retains a held graph across hiding and malformed appends', async () => {
  let raw = encode(2);
  vi.mocked(invoke).mockImplementation(async () => feed(raw));
  const controls = mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain('Network redelivery');
  // Only the toggle pauses following; selection no longer holds the view.
  button('Following').click();
  documentButton('Pause updates').click();
  controls.setVisible(false);
  const reads = vi.mocked(invoke).mock.calls.length;
  raw = encode(4);
  await vi.advanceTimersByTimeAsync(3000);
  expect(invoke).toHaveBeenCalledTimes(reads);
  controls.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain('Paused · new updates');
  expect(container.textContent).not.toContain('Storage duplication');
  button('Paused · new updates').click();
  documentButton('Follow updates').click();
  expect(container.textContent).toContain('Storage duplication');
  raw += '{}\n';
  await vi.advanceTimersByTimeAsync(1000);
  expect(container.textContent).toContain('Line 5');
  expect(container.textContent).toContain('Storage duplication');
  dispose?.();
  dispose = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores a late read after switching tasks', async () => {
  let resolve!: (value: string) => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const controls = mount();
  controls.setTaskId('other');
  resolve(encode(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).not.toContain('Network redelivery');
});

it('does not send a connection prompt after its task host closes during preparation', async () => {
  let finish!: () => void;
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.PrepareReasoningFeed)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return null;
  });
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  dispose?.();
  dispose = undefined;
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).not.toHaveBeenCalled();
});

function editField(label: string, value: string) {
  const input = expectDefined(
    container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`),
  );
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function openNote(id = 'H1') {
  expectDefined(container.querySelector(`[data-record-id="${id}"]`)).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  expectDefined(
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === 'Edit details',
    ),
  ).click();
}
function submitQuestion() {
  expectDefined(container.querySelector('.investigation-note-question')).dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
}
async function mountLiveNote() {
  let raw = encode(2);
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(raw) : null,
  );
  vi.mocked(commitTaskReasoningEdit).mockImplementation(async (_taskId, update) => {
    const history = parseReasoningFeed(raw).history;
    const next = acceptUpdate(history, {
      runId: update.runId ?? '',
      actor: 'user',
      sequence: history.updates.length,
      expectedRevision: update.expectedRevision,
      operations: update.operations,
    });
    raw = next.updates.map((event) => JSON.stringify(event) + '\n').join('');
    return next.snapshots[next.snapshots.length - 1];
  });
  const controls = mount();
  await vi.advanceTimersByTimeAsync(0);
  openNote();
  return controls;
}

it('commits saved graph edits to the canonical log and keeps drafts in the workspace', async () => {
  await mountLiveNote();
  editField('Node title', 'My saved hypothesis');
  button('Save changes').click();
  await vi.advanceTimersByTimeAsync(1000);
  expect(setTaskReasoningWorkspace).toHaveBeenCalled();
  expect(saveState).not.toHaveBeenCalled();
  expect(commitTaskReasoningEdit).toHaveBeenCalled();
  expect(container.querySelector('[data-record-id="H1"]')?.textContent).toContain(
    'My saved hypothesis',
  );
  expect(store.tasks.task.promptDraft).toBe('Keep my draft');
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.every(([channel]) => channel === IPC.ReadReasoningFeed)).toBe(
    true,
  );
});

it('offers to send saved manual changes once, blocks without tools, and queues behind a busy agent', async () => {
  await mountLiveNote();
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
    'Send manual changes to agent',
  );
  editField('Node title', 'My saved hypothesis');
  button('Save changes').click();
  await vi.advanceTimersByTimeAsync(1000);
  setCanvasTools(false);
  expect(button('Send manual changes to agent').disabled).toBe(true);
  setCanvasTools(true);
  setIdle(false);
  button('Send manual changes to agent').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(container.textContent).toContain('1 request queued');
  expect(button('Send manual changes to agent').disabled).toBe(true);
  setIdle(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(sendPrompt).toHaveBeenCalledOnce();
  const [, , prompt, options] = vi.mocked(sendPrompt).mock.calls[0];
  expect(options).toEqual({ appPrompt: true });
  expect(prompt).toContain('My saved hypothesis');
  expect(prompt).toContain('"id":"H1"');
  expect(prompt).toContain('"revision":3');
  expect(prompt).toContain('reasoning_read');
  expect(markTaskUserActivity).toHaveBeenCalledWith('task');
  expect(store.tasks.task.promptDraft).toBe('Keep my draft');
  expect(container.textContent).not.toContain('1 request queued');
  // The digest of what was sent hides the button until the graph changes again.
  expect(Object.values(store.tasks.task.reasoningWorkspaces ?? {}).some((w) => w.sentChanges)).toBe(
    true,
  );
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
    'Send manual changes to agent',
  );
});

it('cancels a queued request from the status line and drops it with a notice when the agent exits', async () => {
  await mountLiveNote();
  editField('Node title', 'My saved hypothesis');
  button('Save changes').click();
  await vi.advanceTimersByTimeAsync(1000);
  setIdle(false);
  button('Send manual changes to agent').click();
  expect(container.textContent).toContain('1 request queued');
  button('Cancel').click();
  expect(container.textContent).not.toContain('1 request queued');
  expect(button('Send manual changes to agent').disabled).toBe(false);
  button('Send manual changes to agent').click();
  expect(container.textContent).toContain('1 request queued');
  setAgentStatus('exited');
  expect(container.textContent).not.toContain('1 request queued');
  expect(showNotification).toHaveBeenCalledWith(
    'The agent stopped before your manual changes could be sent.',
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('sends the current note text and question to the first agent while retaining unsaved edits', async () => {
  await mountLiveNote();
  editField('Node title', 'My unsaved hypothesis');
  editField('Node notes', 'An observation to investigate');
  button('Ask agent').click();
  editField('Question for agent', 'Can you test this possibility?');
  submitQuestion();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).toHaveBeenCalledWith(
    'task',
    'agent',
    expect.stringContaining('Can you test this possibility?'),
    { appPrompt: true },
  );
  const prompt = vi.mocked(sendPrompt).mock.calls[0][2];
  expect(prompt).toContain('My unsaved hypothesis');
  expect(prompt).toContain('An observation to investigate');
  expect(prompt).toContain('"id": "BUG"');
  expect(prompt).toContain('"revision": 2');
  expect(prompt).toContain('"viewedRevision": 2');
  expect(prompt).toContain('"explanationId":');
  expect(prompt).toContain('insert_explanation');
  expect(prompt).toContain('including user-created nodes');
  expect(markTaskUserActivity).toHaveBeenCalledWith('task');
  expect(store.tasks.task.promptDraft).toBe('Keep my draft');
  // A sent question returns the card to its details, with the unsaved edits still there.
  expect(container.querySelector('[aria-label="Question for agent"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('[aria-label="Node title"]')?.value).toBe(
    'My unsaved hypothesis',
  );
  expect(container.textContent).toContain('Question sent to the agent.');
  button('Ask agent').click();
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
  ).toBe('');
});

it('queues a question to a busy agent and sends it once when the agent is ready', async () => {
  setIdle(false);
  await mountLiveNote();
  button('Ask agent').click();
  editField('Question for agent', 'Wait for a safe opportunity');
  expect(button('Send question').disabled).toBe(false);
  submitQuestion();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(container.textContent).toContain('1 request queued');
  setIdle(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(sendPrompt).toHaveBeenCalledOnce();
  expect(vi.mocked(sendPrompt).mock.calls[0][2]).toContain('Wait for a safe opportunity');
  expect(container.textContent).not.toContain('1 request queued');
});

/** Queues a question behind a busy agent; the composer closes once the request waits. */
async function queueQuestion(question: string) {
  setIdle(false);
  await mountLiveNote();
  button('Ask agent').click();
  editField('Question for agent', question);
  submitQuestion();
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain('1 request queued');
}
const questionBox = () =>
  container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value;

it('reports a queued question that fails to send and gives it back for a retry', async () => {
  await queueQuestion('Please check the evidence');
  vi.mocked(sendPrompt).mockRejectedValue(new Error('Agent terminal unavailable'));
  setIdle(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(sendPrompt).toHaveBeenCalledOnce();
  expect(showNotification).toHaveBeenCalledWith(
    'Could not send your question: Agent terminal unavailable. It’s back in the node’s question box.',
  );
  expect(container.textContent).toContain('Agent terminal unavailable');
  button('Ask agent').click();
  expect(questionBox()).toBe('Please check the evidence');
});

it('gives a queued question back when the agent exits before it is sent', async () => {
  await queueQuestion('Please check the evidence');
  setAgentStatus('exited');
  expect(showNotification).toHaveBeenCalledWith(
    'The agent stopped before your question could be sent. It’s back in the node’s question box.',
  );
  button('Ask agent').click();
  expect(questionBox()).toBe('Please check the evidence');
});

it('keeps a newer question and does not claim to restore the dropped one', async () => {
  await queueQuestion('Please check the evidence');
  button('Ask agent').click();
  editField('Question for agent', 'A newer question');
  setAgentStatus('exited');
  expect(showNotification).toHaveBeenCalledWith(
    'The agent stopped before your question could be sent.',
  );
  expect(questionBox()).toBe('A newer question');
});

it('blocks questions when the session has no canvas tools', async () => {
  setCanvasTools(false);
  await mountLiveNote();
  button('Ask agent').click();
  editField('Question for agent', 'Wait for a safe opportunity');
  expect(button('Send question').disabled).toBe(true);
  submitQuestion();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
  ).toBe('Wait for a safe opportunity');
});

it('retains the question after a failed send so it can be retried', async () => {
  vi.mocked(sendPrompt).mockRejectedValue(new Error('Agent terminal unavailable'));
  await mountLiveNote();
  button('Ask agent').click();
  editField('Question for agent', 'Please check the evidence');
  submitQuestion();
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain('Agent terminal unavailable');
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
  ).toBe('Please check the evidence');
  expect(button('Send question').disabled).toBe(false);
});

it('does not clear a newer question typed while the previous send is pending', async () => {
  let finish!: () => void;
  vi.mocked(sendPrompt).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await mountLiveNote();
  button('Ask agent').click();
  editField('Question for agent', 'First question');
  submitQuestion();
  editField('Question for agent', 'Next question');
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
  ).toBe('Next question');
  expect(sendPrompt).toHaveBeenCalledOnce();
});

it('does not clear a question in a new report run when an old send completes', async () => {
  let finish!: () => void;
  let raw = encode(2);
  vi.mocked(sendPrompt).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(raw) : null,
  );
  mount();
  await vi.advanceTimersByTimeAsync(0);
  openNote();
  button('Ask agent').click();
  editField('Question for agent', 'Same question, different report');
  submitQuestion();
  raw =
    raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.stringify({ ...JSON.parse(line), runId: 'new-run' }))
      .join('\n') + '\n';
  await vi.advanceTimersByTimeAsync(1000);
  openNote();
  button('Ask agent').click();
  editField('Question for agent', 'Same question, different report');
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Question for agent"]')?.value,
  ).toBe('Same question, different report');
  expect(container.textContent).not.toContain('Question sent to the agent.');
  expect(Object.keys(store.tasks.task.reasoningWorkspaces ?? {})).toHaveLength(2);
});

it('explains missing session tools and never sends an impossible activation prompt', async () => {
  setCanvasTools(false);
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(button('Start live map').disabled).toBe(true);
  expect(container.textContent).toContain('Canvas tools are unavailable in this session');
  button('Start live map').click();
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendPrompt).not.toHaveBeenCalled();
  setCanvasTools(true);
  expect(button('Start live map').disabled).toBe(false);
});

it('offers to start the live map again after the agent exits and restarts', async () => {
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusDetails()).toContain('Waiting for first update');
  setAgentStatus('exited');
  expect(statusDetails()).not.toContain('Waiting for first update');
  expect(container.textContent).toContain('Start the agent to use the live map');
  expect(button('Start live map').disabled).toBe(true);
  setAgentStatus('running');
  setCanvasTools(undefined);
  expect(container.textContent).toContain('Checking session tools');
  expect(button('Start live map').disabled).toBe(true);
  setCanvasTools(true);
  expect(button('Start live map').disabled).toBe(false);
  button('Start live map').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(statusDetails()).toContain('Waiting for first update');
});

it('ignores a stale activation that completes after the agent restarted', async () => {
  let finish!: () => void;
  vi.mocked(sendPrompt).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  await vi.advanceTimersByTimeAsync(0);
  setAgentStatus('exited');
  setAgentStatus('running');
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusDetails()).not.toContain('Waiting for first update');
  expect(button('Start live map').disabled).toBe(false);
});

it('explains a queued request dropped by a workflow change or an agent exit', async () => {
  setIdle(false);
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Start live map').click();
  expect(container.textContent).toContain('Queued until the agent is ready');
  setTaskReasoningProfile('task', 'research');
  expect(container.textContent).toContain('cancelled because the workflow changed');
  expect(button('Start live map')).toBeDefined();
  button('Start live map').click();
  expect(container.textContent).not.toContain('cancelled because the workflow changed');
  setAgentStatus('exited');
  expect(container.textContent).toContain('The agent stopped before the live map could start');
  await vi.advanceTimersByTimeAsync(1000);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('keeps a live connection through a workflow change and only drops a queued activation', async () => {
  vi.mocked(invoke).mockResolvedValue(feed(encode(2)));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  button('Resume live map').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).toHaveBeenCalledOnce();
  expect(statusDetails()).toContain('Waiting for first update');
  setTaskReasoningProfile('task', 'research');
  expect(statusDetails()).toContain('Waiting for first update');
  expect(container.textContent).not.toContain('cancelled because the workflow changed');
});

it('shows the latest caption while live, a resume hint when not, and flags a stuck append', async () => {
  let raw = encode(2);
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(raw) : null,
  );
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(statusDetails()).toContain(
    'Report from Test agent · Revision 2 · not live · Resume live map to continue this run',
  );
  recordAgentPublication({
    taskId: 'task',
    agentId: 'agent',
    generation: store.agents.agent.generation,
  });
  expect(statusDetails()).toContain(
    `Live · Test agent · Revision 2 · ${makeFixture().updates[1].caption}`,
  );
  raw += '{"runId":"';
  await vi.advanceTimersByTimeAsync(1000);
  expect(container.textContent).toContain('Receiving update…');
  expect(container.textContent).not.toContain('looks incomplete');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(container.textContent).toContain(
    'The last update looks incomplete; the agent may have stopped mid-write.',
  );
  raw = encode(3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(container.textContent).not.toContain('looks incomplete');
  expect(statusDetails()).toContain('Revision 3');
});

it('reports idle time once a live map has been quiet for ten minutes', async () => {
  vi.mocked(invoke).mockResolvedValue(feed(encode(2)));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  recordAgentPublication({
    taskId: 'task',
    agentId: 'agent',
    generation: store.agents.agent.generation,
  });
  await vi.advanceTimersByTimeAsync(9 * 60_000);
  expect(statusDetails()).toContain('Live · Test agent');
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  expect(statusDetails()).toContain('Live · idle 11 m · Revision 2');
});

it('reports idle time as soon as a hidden live map is shown again', async () => {
  vi.mocked(invoke).mockResolvedValue(feed(encode(2)));
  const { setVisible } = mount();
  await vi.advanceTimersByTimeAsync(0);
  recordAgentPublication({
    taskId: 'task',
    agentId: 'agent',
    generation: store.agents.agent.generation,
  });
  setVisible(false);
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(statusDetails()).toContain('Live · idle 11 m');
});

it('opens sources: URLs externally, markdown as a canvas document, other files in the editor', async () => {
  const update = makeFixture().updates[0];
  const first = update.operations[0];
  if (first.type !== 'insert') throw new Error('fixture changed');
  const sources = [
    { label: 'Spec', url: 'https://example.test/spec' },
    { label: 'Notes', path: 'docs/notes.md' },
    { label: 'Log', path: 'logs/run.txt', line: 3 },
  ];
  const sourced = {
    ...update,
    operations: [{ ...first, node: { ...first.node, sources } }, ...update.operations.slice(1)],
  };
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.ReadReasoningFeed ? feed(JSON.stringify(sourced) + '\n') : null,
  );
  vi.mocked(openFileInEditor).mockRejectedValueOnce(new Error('No editor configured'));
  mount();
  await vi.advanceTimersByTimeAsync(0);
  openNote(first.node.id);
  const opens = [...container.querySelectorAll('button')].filter((b) =>
    /^Open( source)?$/.test(b.textContent?.trim() ?? ''),
  );
  expect(opens).toHaveLength(3);
  opens[0].click();
  await vi.advanceTimersByTimeAsync(0);
  expect(invoke).toHaveBeenCalledWith(IPC.ShellOpenExternal, { url: 'https://example.test/spec' });
  opens[2].click();
  await vi.advanceTimersByTimeAsync(0);
  expect(openFileInEditor).toHaveBeenCalledWith('/task', 'logs/run.txt');
  expect(container.textContent).toContain('No editor configured');
  opens[1].click();
  await vi.advanceTimersByTimeAsync(0);
  expect(openCanvasDocument).toHaveBeenCalledWith('task', 'docs/notes.md');
});

it('checks task-relative sources against the checkout and marks missing files', async () => {
  const update = makeFixture().updates[0];
  const first = update.operations[0];
  if (first.type !== 'insert') throw new Error('fixture changed');
  const sources = [
    { label: 'Spec', url: 'https://example.test/spec' },
    { label: 'Log', path: 'logs/run.txt', line: 3 },
    { label: 'Gone', path: 'logs/missing.txt' },
  ];
  const sourced = {
    ...update,
    operations: [{ ...first, node: { ...first.node, sources } }, ...update.operations.slice(1)],
  };
  vi.mocked(invoke).mockImplementation(async (channel, args) => {
    if (channel === IPC.ReadReasoningFeed) return feed(JSON.stringify(sourced) + '\n');
    if (channel === IPC.CheckPathExists) return args?.path === '/task/logs/run.txt';
    return null;
  });
  mount();
  await vi.advanceTimersByTimeAsync(0);
  openNote(first.node.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(invoke).toHaveBeenCalledWith(IPC.CheckPathExists, { path: '/task/logs/run.txt' });
  expect(invoke).toHaveBeenCalledWith(IPC.CheckPathExists, { path: '/task/logs/missing.txt' });
  expect(invoke).not.toHaveBeenCalledWith(
    IPC.CheckPathExists,
    expect.objectContaining({ path: expect.stringContaining('example.test') }),
  );
  expect(container.querySelectorAll('.investigation-source-missing')).toHaveLength(1);
});

it('anchors agent updates observed live and jumps from a note to the update that touched it', async () => {
  const marked = new Set<string>();
  const api = {
    mark: vi.fn((key: string) => void marked.add(key)),
    jump: vi.fn((key: string) => marked.has(key)),
  };
  vi.mocked(invoke).mockResolvedValue(feed(encode(2)));
  dispose = render(
    () => <TaskReasoningGraphHost taskId="task" visible transcriptMarks={() => api} />,
    container,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(api.mark).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(feed(encode(3)));
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.mark).toHaveBeenCalledTimes(1);
  expect(api.mark).toHaveBeenCalledWith('reasoning:2');
  const updates = makeFixture().updates;
  const inserted = updates[2].operations.find((op) => op.type === 'insert');
  const root = updates[0].operations[0];
  if (inserted?.type !== 'insert' || root.type !== 'insert') throw new Error('fixture changed');
  const jump = () =>
    expectDefined(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Jump to transcript'),
    ).click();
  openNote(inserted.node.id);
  jump();
  expect(api.jump).toHaveBeenCalledWith('reasoning:2');
  expect(container.textContent).not.toContain('No transcript position recorded');
  openNote(root.node.id);
  jump();
  expect(api.jump).toHaveBeenLastCalledWith('reasoning:0');
  expect(container.textContent).toContain('No transcript position recorded for this node.');
});
