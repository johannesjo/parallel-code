import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptInput } from './PromptInput';

const { storeMock, setTaskPromptDraft } = vi.hoisted(() => ({
  storeMock: { tasks: {} as Record<string, unknown> },
  setTaskPromptDraft: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined), fireAndForget: vi.fn() }));
vi.mock('../lib/log', () => ({ debug: vi.fn(), warn: vi.fn() }));

vi.mock('../store/store', () => ({
  store: storeMock,
  setTaskPromptDraft,
  sendPrompt: vi.fn(async () => undefined),
  setInitialPrompt: vi.fn(),
  clearInitialPrompt: vi.fn(),
  registerFocusFn: vi.fn(),
  unregisterFocusFn: vi.fn(),
  registerAction: vi.fn(),
  unregisterAction: vi.fn(),
  getAgentOutputTail: () => '',
  stripAnsi: (s: string) => s,
  onAgentReady: vi.fn(),
  offAgentReady: vi.fn(),
  normalizeCurrentFrame: (s: string) => s,
  looksLikeQuestion: () => false,
  isAgentTrustQuestionAutoHandled: () => false,
  isAutoTrustSettling: () => false,
  isAgentAskingQuestion: () => false,
  isAgentIdle: () => true,
  setTaskLastInputAt: vi.fn(),
  isPanelFocused: () => false,
  setTaskControl: vi.fn(),
  markTaskUserActivity: vi.fn(),
  setTaskPromptDraftActive: vi.fn(),
  setTaskTerminalInputPending: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock('../store/tasks', () => ({
  clearStagedNotification: vi.fn(),
  setTaskTerminalInputPendingFromQuestion: vi.fn(),
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  storeMock.tasks = {};
  setTaskPromptDraft.mockClear();
});

async function waitFor(probe: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition never became true');
}

function mount(taskId: string): HTMLTextAreaElement {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(() => <PromptInput taskId={taskId} taskName="Task" agentId="agent-1" />, container),
  );
  const el = container.querySelector<HTMLTextAreaElement>('textarea.prompt-textarea');
  if (!el) throw new Error('textarea not rendered');
  return el;
}

describe('PromptInput draft persistence', () => {
  it('shows the draft restored from the store on mount', () => {
    storeMock.tasks = { 'task-1': { id: 'task-1', promptDraft: 'half-written thought' } };
    expect(mount('task-1').value).toBe('half-written thought');
  });

  it('starts empty when the task has no saved draft', () => {
    storeMock.tasks = { 'task-1': { id: 'task-1' } };
    expect(mount('task-1').value).toBe('');
  });

  it('writes typed text back to the store so autosave persists it', () => {
    storeMock.tasks = { 'task-1': { id: 'task-1' } };
    const textarea = mount('task-1');

    textarea.value = 'remember the migration';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(setTaskPromptDraft).toHaveBeenCalledWith('task-1', 'remember the migration');
  });

  it('clears the stored draft once the prompt is sent', async () => {
    storeMock.tasks = { 'task-1': { id: 'task-1', promptDraft: 'send me' } };
    const textarea = mount('task-1');

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => setTaskPromptDraft.mock.calls.some(([, text]) => text === ''));

    expect(textarea.value).toBe('');
  });
});
