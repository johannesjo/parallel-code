import { render } from 'solid-js/web';
import { batch } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatView, type ChatProps } from './ChatView';
import type { AgentChatState, ChatItem } from '../../../electron/shared/agent-chat-types';
import { mod } from '../../lib/platform';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
// `props` is the plain record each test reads and patches; `live` is the store the
// view renders from, updated the way the app updates it: frames reconciled by id.
let props: ChatProps;
let live: ChatProps;
let setLive: (key: keyof ChatProps, value: unknown) => void;
let setFrame: (state: AgentChatState) => void;
let scope: object;
const send = vi.fn(async () => {});
const respond = vi.fn(async () => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function update(patch: Partial<ChatProps> = {}) {
  props = { ...props, ...patch };
  batch(() => {
    for (const [key, value] of Object.entries(props) as [keyof ChatProps, unknown][])
      if (key === 'state') setFrame(value as AgentChatState);
      else setLive(key, value);
  });
  await settle();
}
async function act(action: () => unknown) {
  await action();
  await settle();
}
function mount() {
  dispose = render(() => <ChatView {...live} />, container);
}
const composer = () => {
  const input = container.querySelector('textarea');
  if (!input) throw new Error('Chat composer is missing');
  return input;
};
const button = (label: string) => {
  const element = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === label || button.getAttribute('aria-label') === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
};
/** Types `text` at the end of the draft one character at a time, as a keyboard does. */
async function type(text: string) {
  for (const data of text) {
    const input = composer();
    input.value += data;
    input.setSelectionRange(input.value.length, input.value.length);
    await act(() => input.dispatchEvent(new InputEvent('input', { data, bubbles: true })));
  }
}
async function pickFile(path: string) {
  await type(' @');
  await act(() => button(path).click());
  await act(() => button('Done').click());
}
async function drop(files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } });
  await act(async () => {
    composer().dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
const screenshot = () => new File(['image data'], 'screen.png', { type: 'image/png' });
const enter = (init: KeyboardEventInit = {}) =>
  composer().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  scope = {};
  props = {
    agentName: 'Claude',
    state: {
      status: 'ready',
      threadId: 'thread',
      items: [{ id: 'u', kind: 'user', text: 'Earlier prompt' }],
      requests: [],
    },
    draft: 'Keep my draft',
    disabled: false,
    active: true,
    memoryScope: scope,
    onDraft: (draft) => {
      props = { ...props, draft };
      setLive('draft', draft);
    },
    onSend: send,
    onStop: vi.fn(async () => {}),
    onRespond: respond,
    onActions: vi.fn(),
    onSelectModel: vi.fn(async () => {}),
    onReloadModels: vi.fn(async () => {}),
  };
  const [store, setStore] = createStore({} as ChatProps);
  // eslint-disable-next-line solid/reactivity -- spread into the view, which tracks it
  live = store;
  // A store setter calls a function value as an updater, so callbacks go in wrapped.
  setLive = (key, value) =>
    (setStore as (key: string, value: unknown) => void)(
      key,
      typeof value === 'function' ? () => value : value,
    );
  setFrame = (state) => setStore('state', reconcile(structuredClone(state)));
  for (const [key, value] of Object.entries(props)) setLive(key as keyof ChatProps, value);
  mount();
});
afterEach(() => {
  dispose?.();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps a rejected draft in the composer and exposes its focus to the app', async () => {
  send.mockRejectedValueOnce(new Error('Agent disconnected'));
  await update();
  composer().focus();
  expect(document.activeElement).toBe(composer());
  await act(() => enter());
  expect(send).toHaveBeenCalledWith('Keep my draft', []);
  expect(composer().value).toBe('Keep my draft');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Agent disconnected');
});

it('empties the composer at once and shows the message as sending until the agent has it', async () => {
  let accept = () => {};
  send.mockImplementationOnce(() => new Promise<void>((resolve) => (accept = resolve)));
  await act(() => enter());
  expect(composer().value).toBe('');
  const sending = () => container.querySelector('.chat-user-sending');
  expect(sending()?.textContent).toContain('Keep my draft');
  // The agent starts its turn before it confirms the message: Stop takes Send's place.
  await update({ state: { ...props.state, status: 'working' } });
  expect(button('Stop response')).toBeDefined();
  expect(() => button('Send message')).toThrow();
  expect(() => button('Queue message')).toThrow();
  await act(() => accept());
  expect(sending()).not.toBeNull();
  await update({
    state: {
      ...props.state,
      items: [...props.state.items, { id: 'u2', kind: 'user', text: 'Keep my draft' }],
    },
  });
  expect(sending()).toBeNull();
  expect(container.querySelectorAll('.chat-user-message')).toHaveLength(2);
});

it('puts a failed message back without overwriting what the user typed since', async () => {
  let reject = (_error: Error) => {};
  send.mockImplementationOnce(() => new Promise<void>((_, fail) => (reject = fail)));
  await act(() => enter());
  expect(composer().value).toBe('');
  await update({ draft: 'Something newer' });
  await act(() => reject(new Error('Agent disconnected')));
  expect(container.querySelector('.chat-user-sending')).toBeNull();
  expect(composer().value).toBe('Something newer');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Agent disconnected');
});

it('keeps an in-progress draft focused when a request arrives', async () => {
  await update();
  composer().focus();
  await update({
    state: {
      ...props.state,
      status: 'working',
      requests: [{ id: 'approval', kind: 'approval', text: 'Run tests?', since: 1 }],
    },
  });
  expect(document.activeElement).toBe(composer());
  expect(composer().value).toBe('Keep my draft');
  expect(container.querySelector('.chat-request')?.textContent).toContain('Run tests?');
});

it('returns focus to the surviving composer after a streamed request disappears', async () => {
  let release = () => {};
  respond.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await update({ draft: '' });
  composer().focus();
  await update({
    state: {
      ...props.state,
      status: 'working',
      requests: [{ id: 'approval', kind: 'approval', text: 'Run tests?', since: 1 }],
    },
  });
  expect(document.activeElement?.textContent).toBe('Allow once');
  await act(() => (document.activeElement as HTMLButtonElement).click());
  await update({ state: { ...props.state, requests: [] } });
  await act(() => release());
  expect(document.activeElement).toBe(composer());
});

it('lets the app hand the keyboard to a pending question', async () => {
  const sidebar = document.createElement('button');
  document.body.append(sidebar);
  const actions = () => vi.mocked(props.onActions).mock.calls[0]?.[0];
  try {
    expect(actions()?.focusRequest()).toBe(false);
    // The question arrives while the user is elsewhere, so it waits for them.
    sidebar.focus();
    await update({
      state: {
        ...props.state,
        status: 'working',
        requests: [
          {
            id: 'question',
            kind: 'question',
            text: 'Claude needs your input',
            since: 1,
            questions: [
              {
                id: 'scope',
                question: 'Which scope?',
                isSecret: false,
                options: [{ label: 'Narrow', description: '' }],
              },
            ],
          },
        ],
      },
    });
    expect(document.activeElement).toBe(sidebar);
    // Unsent text keeps the composer: Enter there means "send my message".
    expect(composer().value).toBe('Keep my draft');
    expect(actions()?.focusRequest()).toBe(false);
    expect(document.activeElement).toBe(sidebar);
    // A bare `!` leaves the field empty, but it is still the user's shell draft.
    await update({ draft: '!', onShell: vi.fn(async () => {}) });
    expect(composer().value).toBe('');
    expect(actions()?.focusRequest()).toBe(false);
    // Coming back to the chat otherwise answers it from the keyboard.
    await update({ draft: '' });
    expect(actions()?.focusRequest()).toBe(true);
    expect(document.activeElement?.firstChild?.textContent).toBe('Narrow');
  } finally {
    sidebar.remove();
  }
});

it('queues during execution, then sends once after the agent becomes ready', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(() => button('Queue message').click());
  expect(send).not.toHaveBeenCalled();
  expect(props.draft).toBe('');
  expect(container.querySelector('.chat-queue')?.textContent).toContain('Keep my draft');
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('Keep my draft', []);
  expect(container.querySelector('.chat-queue')).toBeNull();
});

/** A mid-turn reader scrolled 100px into a log where the bottom is 700px down. */
async function scrolledBackMidTurn() {
  // happy-dom has no layout: fake a 300px viewport over 1000px of log.
  const log = container.querySelector<HTMLElement>('.chat-scroll');
  if (!log) throw new Error('Chat log is missing');
  let top = 0;
  Object.defineProperty(log, 'scrollHeight', { get: () => 1000 });
  Object.defineProperty(log, 'clientHeight', { get: () => 300 });
  Object.defineProperty(log, 'scrollTop', {
    get: () => top,
    set: (value: number) => (top = Math.max(0, Math.min(value, 700))),
  });
  await update({ state: { ...props.state, status: 'working' } });
  top = 100;
  log.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  return () => top;
}

it('brings a scrolled reader back to the latest message when they queue one', async () => {
  const top = await scrolledBackMidTurn();
  await act(() => button('Queue message').click());
  expect(container.querySelector('.chat-queue')?.textContent).toContain('Keep my draft');
  expect(top()).toBe(700);
});

it('brings a scrolled reader back to the latest message when they interrupt and send', async () => {
  const top = await scrolledBackMidTurn();
  await act(() => button('Interrupt and send now').click());
  expect(props.onStop).toHaveBeenCalledTimes(1);
  expect(top()).toBe(700);
});

it('retains a failed queued message and only retries on request', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(() => button('Queue message').click());
  send.mockRejectedValueOnce(new Error('Disconnected'));
  await update({ state: { ...props.state, status: 'ready' } });
  await update();
  expect(send).toHaveBeenCalledTimes(1);
  expect(container.querySelector('.chat-queue')?.textContent).toContain('Queue paused');
  await act(() => button('Retry queued message').click());
  expect(send).toHaveBeenCalledTimes(2);
  expect(container.querySelector('.chat-queue')).toBeNull();
});

it.each(['a stopped turn', 'a failed send'] as const)(
  'sends a message queued after %s once the agent is ready',
  async (earlier) => {
    if (earlier === 'a stopped turn') {
      await update({ draft: '', state: { ...props.state, status: 'working' } });
      await act(() => button('Stop response').click());
    } else {
      send.mockRejectedValueOnce(new Error('Disconnected'));
      await act(() => button('Send message').click());
      send.mockClear();
    }
    await update({ draft: 'Later follow-up', state: { ...props.state, status: 'working' } });
    await act(() => button('Queue message').click());
    expect(container.querySelector('.chat-queue')?.textContent).not.toContain('Queue paused');
    await update({ state: { ...props.state, status: 'ready' } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('Later follow-up', []);
  },
);

it('interrupts first and waits for confirmed idle before sending a follow-up', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(() => button('Interrupt and send now').click());
  expect(props.onStop).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([{ key: 'Escape' }, { key: 'c', ctrlKey: true }])(
  'interrupts with $key while preserving the draft and pausing queued messages',
  async (shortcut) => {
    await update({ state: { ...props.state, status: 'working' } });
    await act(() => button('Queue message').click());
    await update({ draft: 'Unsent follow-up' });
    const event = new KeyboardEvent('keydown', {
      ...shortcut,
      bubbles: true,
      cancelable: true,
    });
    await act(() => composer().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.draft).toBe('Unsent follow-up');
    await update({ state: { ...props.state, status: 'ready' } });
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector('.chat-queue')?.textContent).toContain('Queue paused');
  },
);

it('keeps Ctrl+C available for copying selected draft text', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  composer().setSelectionRange(0, 4);
  const event = new KeyboardEvent('keydown', {
    key: 'c',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(() => composer().dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(props.onStop).not.toHaveBeenCalled();
});

it.each([
  { key: 'Escape', isComposing: true },
  { key: 'Escape', repeat: true },
  { key: 'c', metaKey: true },
  { key: 'c', ctrlKey: true, shiftKey: true },
])('does not interrupt for composing, repeated, or other shortcuts: %j', async (shortcut) => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(() =>
    composer().dispatchEvent(
      new KeyboardEvent('keydown', {
        ...shortcut,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(props.onStop).not.toHaveBeenCalled();
});

it('leaves Escape alone when idle and dismisses command completion before interrupting', async () => {
  await act(() =>
    composer().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    ),
  );
  expect(props.onStop).not.toHaveBeenCalled();
  await update({
    draft: '/',
    state: {
      ...props.state,
      status: 'working',
      commands: [{ name: 'help', description: 'Help', argumentHint: '' }],
    },
  });
  await act(() =>
    composer().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    ),
  );
  expect(props.onStop).not.toHaveBeenCalled();
  expect(composer().getAttribute('aria-expanded')).toBe('false');
  await act(() =>
    composer().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    ),
  );
  expect(props.onStop).toHaveBeenCalledTimes(1);
});

it('preserves the draft if interruption fails', async () => {
  await update({
    state: { ...props.state, status: 'working' },
    onStop: vi.fn(async () => {
      throw new Error('Could not stop');
    }),
  });
  await act(() => button('Interrupt and send now').click());
  expect(props.draft).toBe('Keep my draft');
  expect(send).not.toHaveBeenCalled();
  expect(container.querySelector('.chat-queue')).toBeNull();
});

it('blocks Enter during interruption and sends the original prompt while preserving a newer draft', async () => {
  let release = () => {};
  await update({
    state: { ...props.state, status: 'working' },
    onStop: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    onListFiles: async () => ['src/app.ts'],
  });
  await pickFile('src/app.ts');
  await act(() => button('Interrupt and send now').click());
  await act(() => enter());
  expect(container.querySelector('.chat-queue')).toBeNull();
  expect(props.draft).toBe('Keep my draft ');
  await update({ draft: 'Still writing this' });
  await act(() => release());
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('Keep my draft\n\nReferenced files:\n"src/app.ts"', []);
  expect(props.draft).toBe('Still writing this');
  expect(container.querySelector('.chat-queue')).toBeNull();
});

it('routes markdown file links with locations without intercepting external links', async () => {
  const onOpenFile = vi.fn();
  await update({
    onOpenFile,
    state: {
      ...props.state,
      items: [
        {
          id: 'links',
          kind: 'assistant',
          text: '[Source](/worktree/src/app.ts:12:3) [Readme](README.md:12) [Relative](src/app.ts:4) [Space](docs/design%20notes.md:9) [Web](https://example.com:123) [Email](mailto:dev@example.com) [Unsafe](javascript:alert%281%29) `README.md:12`',
        },
      ],
    },
  });
  const links = Array.from(container.querySelectorAll('a'));
  for (const label of ['Source', 'Readme', 'Relative', 'Space', 'Web', 'Email']) {
    const link = links.find((link) => link.textContent === label);
    expect(link, label).toBeDefined();
    await act(() =>
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
  }
  expect(onOpenFile.mock.calls).toEqual([
    ['/worktree/src/app.ts:12:3'],
    ['README.md:12'],
    ['src/app.ts:4'],
    ['docs/design notes.md:9'],
  ]);
  expect(links.some((link) => link.getAttribute('href')?.startsWith('javascript:'))).toBe(false);
  expect(container.querySelector('code')?.textContent).toBe('README.md:12');
});

it('keeps a cancelled queue edit and the existing draft intact', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(() => button('Queue message').click());
  await update({ draft: 'A different draft' });
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
  await act(() => button('Edit').click());
  expect(props.draft).toBe('A different draft');
  expect(container.querySelector('.chat-queue')?.textContent).toContain('Keep my draft');
});

it('groups activity and preserves open details when another operation arrives', async () => {
  const tool = (id: string) => ({
    id,
    kind: 'tool' as const,
    text: 'output',
    activity: {
      type: 'command' as const,
      label: 'npm test',
      status: 'completed' as const,
      exitCode: 0,
    },
  });
  await update({
    state: { ...props.state, items: [...props.state.items, tool('one'), tool('two')] },
  });
  const group = container.querySelector<HTMLDetailsElement>('.chat-activity-group > details');
  if (!group) throw new Error('Missing activity group');
  group.open = true;
  const row = container.querySelector<HTMLDetailsElement>('.chat-tool');
  if (!row) throw new Error('Missing activity row');
  row.open = true;
  await update({ state: { ...props.state, items: [...props.state.items, tool('three')] } });
  expect(container.querySelectorAll('.chat-activity-group')).toHaveLength(1);
  expect(container.querySelector('.chat-activity-group > details')).toBe(group);
  expect(group.open).toBe(true);
  expect(container.querySelector('.chat-tool')).toBe(row);
  expect(row.open).toBe(true);
  expect(group.querySelector('.chat-activity-label')?.textContent).toBe('3 commands');
});

it('opens failed activity and connects file actions to the existing review surface', async () => {
  const onReview = vi.fn();
  const onOpenFile = vi.fn();
  await update({
    onReview,
    onOpenFile,
    state: {
      ...props.state,
      items: [
        {
          id: 'failed',
          kind: 'tool',
          text: 'Patch failed',
          activity: { type: 'files', files: ['src/app.ts'], label: 'src/app.ts', status: 'failed' },
        },
      ],
    },
  });
  expect(container.querySelector<HTMLDetailsElement>('.chat-activity-group > details')?.open).toBe(
    true,
  );
  expect(container.querySelector<HTMLDetailsElement>('.chat-tool')?.open).toBe(true);
  await act(() => button('Review diff').click());
  expect(onReview).toHaveBeenCalledWith('src/app.ts');
  await act(() => button('src/app.ts').click());
  expect(onOpenFile).toHaveBeenCalledWith('src/app.ts');
});

it('names no placeholder model before the session reports its own', async () => {
  await update({ state: { ...props.state, model: undefined, models: [] } });
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Model"]');
  expect(select?.textContent).toBe('');
});

it('names no placeholder level before the session reports its own', async () => {
  await update({
    state: {
      ...props.state,
      model: 'model-a',
      reasoningEffort: undefined,
      models: [
        {
          model: 'model-a',
          displayName: 'Model A',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Thorough' }],
        },
      ],
    },
  });
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]');
  expect(select?.value).toBe('');
  expect(select?.textContent).toBe('High');
});

it('renders separate model, reasoning and permission settings in the composer', async () => {
  const onPermissionMode = vi.fn(async () => {});
  await update({
    permissionMode: 'plan',
    onPermissionMode,
    state: {
      ...props.state,
      model: 'model-a',
      models: [
        {
          model: 'model-a',
          displayName: 'Model A',
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Thorough' }],
        },
      ],
    },
  });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Model"]')?.value).toBe('model-a');
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]')?.value).toBe(
    'high',
  );
  const mode = container.querySelector<HTMLSelectElement>('[aria-label="Permission mode"]');
  if (!mode) throw new Error('Missing permission control');
  expect(mode.value).toBe('plan');
  await act(() => {
    mode.value = 'auto';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(onPermissionMode).toHaveBeenCalledWith('auto');
});

it('hides unsupported reasoning and restores it when a capable model is selected', async () => {
  const models = [
    { model: 'basic', displayName: 'Basic', supportedReasoningEfforts: [] },
    {
      model: 'thinking',
      displayName: 'Thinking',
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [
        { reasoningEffort: 'high', description: 'Thorough' },
        { reasoningEffort: 'low', description: 'Quick' },
      ],
    },
  ];
  await update({ state: { ...props.state, model: 'basic', models } });
  expect(container.querySelector('[aria-label="Reasoning effort"]')).toBeNull();
  await update({ state: { ...props.state, model: 'thinking' } });
  const effort = container.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]');
  if (!effort) throw new Error('Missing reasoning control');
  expect(effort.value).toBe('high');
  await act(() => {
    effort.value = 'low';
    effort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(props.onSelectModel).toHaveBeenCalledWith('thinking', 'low');
  await update({ state: { ...props.state, reasoningEffort: 'low' } });
  await update({ state: { ...props.state, model: 'basic' } });
  expect(container.querySelector('[aria-label="Reasoning effort"]')).toBeNull();
});

it('names the reported effort instead of offering Default when the catalog has none', async () => {
  const models = [
    {
      model: 'claude',
      displayName: 'Claude',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium', description: '' },
        { reasoningEffort: 'high', description: '' },
      ],
    },
  ];
  await update({ state: { ...props.state, model: 'claude', models, reasoningEffort: 'medium' } });
  const effort = container.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]');
  expect(effort?.value).toBe('medium');
  expect([...(effort?.options ?? [])].map((option) => option.text)).toEqual(['Medium', 'High']);
});

it('retains queued follow-ups across reconnects and requires an explicit retry', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(() => button('Queue message').click());
  await update({ state: { ...props.state, status: 'closed' } });
  await update({ state: { ...props.state, status: 'starting' } });
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).not.toHaveBeenCalled();
  expect(container.querySelector('.chat-queue')?.textContent).toContain('Queue paused');
  await act(() => button('Retry queued message').click());
  expect(send).toHaveBeenCalledTimes(1);
});

it('does not submit while an IME composition is active', async () => {
  await update();
  await act(() => enter({ isComposing: true }));
  expect(send).not.toHaveBeenCalled();
});

it('allows file references to be removed and sends selected paths as visible context', async () => {
  await update({ onListFiles: async () => ['src/app.ts', 'README.md'] });
  await pickFile('src/app.ts');
  expect(container.querySelector('.chat-context-chips')?.textContent).toContain('src/app.ts');
  expect(props.draft).toBe('Keep my draft ');
  expect(document.activeElement).toBe(composer());
  expect(composer().selectionStart).toBe('Keep my draft '.length);
  await act(() => button('Send message').click());
  expect(send).toHaveBeenCalledWith('Keep my draft\n\nReferenced files:\n"src/app.ts"', []);
  expect(container.querySelector('.chat-context-chips')?.textContent).not.toContain('src/app.ts');
});

it('keeps a typed @ when the file search closes without a choice', async () => {
  await update({ onListFiles: async () => ['src/app.ts'] });
  await type('a@');
  expect(container.querySelector('.chat-file-picker')).toBeNull();
  await type(' @');
  await act(() => button('Done').click());
  expect(container.querySelector('.chat-file-picker')).toBeNull();
  expect(props.draft).toBe('Keep my drafta@ @');
  expect(composer().selectionStart).toBe('Keep my drafta@ @'.length);
});

const commands = [
  { name: 'review-pr', description: 'Review a pull request', argumentHint: '' },
  { name: 'review', description: 'Review the diff', argumentHint: '<pr>' },
  { name: 'compact', description: 'Summarize the conversation', argumentHint: '' },
  { name: 'pr-comments', description: 'Show PR comments', argumentHint: '' },
  { name: 'plugin:docx', description: 'Edit Word files', argumentHint: '' },
];
/** Presses a key in the composer; true when nothing handled it. */
const press = (key: string, init: KeyboardEventInit = {}) =>
  composer().dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
const suggestions = () =>
  Array.from(container.querySelectorAll('[role="option"]'), (option) => ({
    text: option.textContent,
    selected: option.getAttribute('aria-selected') === 'true',
  }));

it('completes slash commands and skills like a terminal', async () => {
  await update({ draft: '', state: { ...props.state, commands } });
  expect(composer().placeholder).toContain('/ for commands');
  expect(composer().getAttribute('aria-expanded')).toBe('false');
  await type('/r');
  expect(composer().getAttribute('aria-expanded')).toBe('true');
  // Names that only contain the query, such as pr-comments, are left out.
  expect(suggestions()).toEqual([
    { text: '/review-prReview a pull request', selected: true },
    { text: '/review <pr>Review the diff', selected: false },
  ]);
  await act(() => press('ArrowUp'));
  expect(suggestions().map((option) => option.selected)).toEqual([false, true]);
  await act(() => press('ArrowDown'));
  expect(suggestions().map((option) => option.selected)).toEqual([true, false]);
  await act(() => press('Tab'));
  expect(props.draft).toBe('/review-pr ');
  expect(suggestions()).toEqual([]);
  expect(send).not.toHaveBeenCalled();

  await update({ draft: '' });
  await type('/comp');
  await act(() => enter());
  expect(props.draft).toBe('/compact ');
  expect(send).not.toHaveBeenCalled();
  await act(() => enter());
  expect(send).toHaveBeenCalledWith('/compact', []);

  // A plugin skill matches by its own name as well as by the plugin's.
  await update({ draft: '' });
  await type('/docx');
  expect(suggestions()).toEqual([{ text: '/plugin:docxEdit Word files', selected: true }]);
  const option = container.querySelector<HTMLElement>('[role="option"]');
  await act(() => option?.click());
  expect(props.draft).toBe('/plugin:docx ');
});

it('completes Codex skills with dollar syntax from either trigger', async () => {
  await update({
    draft: '',
    state: {
      ...props.state,
      commands: [{ name: 'review', description: 'Review code', argumentHint: '', prefix: '$' }],
    },
  });
  expect(composer().placeholder).toContain('$ for skills');
  await type('$re');
  expect(suggestions()).toEqual([{ text: '$reviewReview code', selected: true }]);
  await act(() => press('Tab'));
  expect(props.draft).toBe('$review ');
  await update({ draft: '' });
  await type('/review');
  await act(() => enter());
  expect(props.draft).toBe('$review ');
  expect(send).not.toHaveBeenCalled();
  await act(() => enter());
  expect(send).toHaveBeenLastCalledWith('$review', []);
  await update({ draft: '' });
  await type('$review');
  await act(() => enter());
  expect(send).toHaveBeenCalledTimes(2);
});

it('sends a fully typed command and leaves a dismissed or unmatched slash alone', async () => {
  await update({ draft: '', state: { ...props.state, commands } });
  await type('/review');
  // The exact name goes first, even though the agent lists review-pr before it.
  expect(suggestions()[0]).toEqual({ text: '/review <pr>Review the diff', selected: true });
  await act(() => enter());
  expect(send).toHaveBeenLastCalledWith('/review', []);
  // A name typed in other case is corrected rather than sent as the agent might not know it.
  await update({ draft: '' });
  await type('/Compact');
  await act(() => enter());
  expect(props.draft).toBe('/compact ');
  expect(send).toHaveBeenLastCalledWith('/review', []);

  await update({ draft: '' });
  await type('/re');
  expect(press('Tab', { shiftKey: true })).toBe(true);
  expect(press('Tab', { ctrlKey: true })).toBe(true);
  expect(props.draft).toBe('/re');
  await act(() => press('Escape'));
  expect(suggestions()).toEqual([]);
  await type('v');
  expect(suggestions()).toHaveLength(2);
  await act(() => press('Escape'));
  await act(() => enter());
  expect(send).toHaveBeenLastCalledWith('/rev', []);

  await update({ draft: '' });
  await type('/src/app.ts');
  expect(suggestions()).toEqual([]);
  await update({ draft: '' });
  await type('/re and /re');
  expect(suggestions()).toEqual([]);
});

it('puts the caret where the @ was when a file is picked mid-draft', async () => {
  await update({ onListFiles: async () => ['src/app.ts'] });
  const input = composer();
  input.value = 'Keep @my draft';
  input.setSelectionRange(6, 6);
  await act(() => input.dispatchEvent(new InputEvent('input', { data: '@', bubbles: true })));
  await act(() => button('src/app.ts').click());
  await act(() => button('Done').click());
  expect(props.draft).toBe('Keep my draft');
  expect(composer().selectionStart).toBe(5);
});

it('references dropped files by path and rejects files with none', async () => {
  const paths = new Map([
    ['app.ts', 'src/app.ts'],
    ['report.pdf', '/home/me/Downloads/report.pdf'],
  ]);
  await update({ dropPathFor: (file: File) => paths.get(file.name) });
  await drop([new File(['x'], 'app.ts'), new File(['x'], 'report.pdf')]);
  const chips = container.querySelector('.chat-context-chips')?.textContent;
  expect(chips).toContain('src/app.ts');
  expect(chips).toContain('/home/me/Downloads/report.pdf');
  await drop([new File(['x'], 'from-browser.txt')]);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('from-browser.txt');
});

it('keeps the usable part of a drop that also holds a file without a path', async () => {
  const onDisk = new File(['x'], 'app.ts');
  await update({ dropPathFor: (file: File) => (file === onDisk ? 'src/app.ts' : undefined) });
  await drop([screenshot(), onDisk, new File(['x'], 'notes.txt')]);
  const chips = container.querySelector('.chat-context-chips')?.textContent;
  expect(chips).toContain('screen.png');
  expect(chips).toContain('src/app.ts');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('notes.txt');
});

it('finds tool output inside collapsed activity and opens the matching entry', async () => {
  const scrollIntoView = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView);
  await update({
    state: {
      ...props.state,
      items: [
        {
          id: 'tool',
          kind: 'tool',
          text: 'needle in command output',
          activity: { type: 'command', label: 'npm test', status: 'completed' },
        },
      ],
    },
  });
  await act(() => button('Search conversation').click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search conversation"]');
  if (!input) throw new Error('Missing search field');
  await act(() => {
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const result = container.querySelector<HTMLButtonElement>('.chat-search-results button');
  expect(result?.textContent).toContain('needle');
  await act(() => result?.click());
  expect(container.querySelector<HTMLDetailsElement>('.chat-tool')?.open).toBe(true);
  expect(container.querySelector<HTMLDetailsElement>('.chat-activity-group > details')?.open).toBe(
    true,
  );
  expect(scrollIntoView).toHaveBeenCalled();
});

it('opens search from Ctrl+F without a toolbar and hands focus back on Escape', async () => {
  await update({ hideToolbar: true, onReview: vi.fn() });
  expect(container.querySelector('.chat-toolbar')).toBeNull();
  expect(container.textContent).not.toContain('Review changes');
  const shortcut = new KeyboardEvent('keydown', {
    key: 'f',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(() => composer().dispatchEvent(shortcut));
  expect(shortcut.defaultPrevented).toBe(true);
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search conversation"]');
  if (!input) throw new Error('Missing search field');
  expect(document.activeElement).toBe(input);
  await act(() =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(container.querySelector('[aria-label="Search conversation"]')).toBeNull();
  expect(document.activeElement).toBe(composer());
});

it('keeps New chat and search in the more menu, and New chat not mid-turn', async () => {
  const menuItem = (label: string) => {
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (element) => element.textContent?.startsWith(label),
    );
    if (!item) throw new Error(`Missing menu item: ${label}`);
    return item;
  };
  // The phone keeps its toolbar and has no New chat, so it has nothing to put there.
  expect(container.querySelector('[aria-label="More actions"]')).toBeNull();
  const onNewChat = vi.fn();
  await update({ onNewChat, hideToolbar: true });
  await act(() => button('More actions').click());
  await act(() => menuItem('New chat').click());
  expect(onNewChat).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(() => button('More actions').click());
  await act(() => menuItem('Search conversation').click());
  await settle();
  expect(document.activeElement).toBe(
    container.querySelector('[aria-label="Search conversation"]'),
  );
  await update({ state: { ...props.state, status: 'working' } });
  await act(() => button('More actions').click());
  expect(menuItem('New chat').disabled).toBe(true);
  await act(() => button('More actions').click());
});

it('offers earlier conversations in the more menu and walks it by keyboard', async () => {
  const open = vi.fn();
  await update({ onNewChat: vi.fn(), hideToolbar: true, history: [{ title: 'Older', open }] });
  // A real click focuses the button, which is where Escape hands focus back.
  button('More actions').focus();
  await act(() => button('More actions').click());
  await settle();
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Switch conversation');
  expect(items().map((item) => item.textContent)).toEqual([
    'New chat',
    `Search conversation${mod}+F`,
    'Older',
  ]);
  // The first entry takes focus on the next frame.
  await vi.waitFor(() => expect(document.activeElement).toBe(items()[0]));
  const key = (name: string) =>
    act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true }),
      ),
    );
  // Arrow keys wrap around both ends.
  await key('ArrowUp');
  expect(document.activeElement).toBe(items()[2]);
  await key('ArrowDown');
  expect(document.activeElement).toBe(items()[0]);
  await key('Escape');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(button('More actions'));
  await act(() => button('More actions').click());
  await act(() => items()[2].click());
  expect(open).toHaveBeenCalledTimes(1);
  await update({ state: { ...props.state, status: 'working' } });
  await act(() => button('More actions').click());
  expect(items()[2].disabled).toBe(true);
  await act(() => button('More actions').click());
});

it('keeps queued work when the chat view is remounted and pauses delivery', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(() => button('Queue message').click());
  dispose?.();
  mount();
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).not.toHaveBeenCalled();
  expect(container.querySelector('.chat-queue')?.textContent).toContain('Keep my draft');
  expect(container.querySelector('.chat-queue')?.textContent).toContain('Queue paused');
});

it('retains image context when delivery fails', async () => {
  await update();
  await drop([screenshot()]);
  expect(container.querySelector('.chat-context-chips')?.textContent).toContain('screen.png');
  send.mockRejectedValueOnce(new Error('Disconnected'));
  await act(() => button('Send message').click());
  expect(container.querySelector('.chat-context-chips')?.textContent).toContain('screen.png');
  expect(props.draft).toBe('Keep my draft');
});

it('keeps each conversation’s unsent attachments to itself', async () => {
  await update({ onListFiles: async () => ['src/app.ts'] });
  await pickFile('src/app.ts');
  await update({ state: { ...props.state, threadId: 'other-thread', items: [] } });
  expect(container.querySelector('.chat-context-chips')?.textContent).not.toContain('src/app.ts');
  await update({ state: { ...props.state, threadId: 'thread' } });
  expect(container.querySelector('.chat-context-chips')?.textContent).toContain('src/app.ts');
});

it('keeps edits compact with numbered diffs available on demand', async () => {
  const onReview = vi.fn();
  await update({
    onReview,
    state: {
      ...props.state,
      items: [
        {
          id: 'run',
          kind: 'tool',
          text: '1 passed',
          activity: {
            type: 'command',
            command: 'npm test',
            label: 'npm test',
            status: 'completed',
          },
        },
        {
          id: 'edit',
          kind: 'tool',
          text: '',
          activity: {
            type: 'files',
            files: ['src/app.ts'],
            label: 'src/app.ts',
            status: 'completed',
            diffs: [
              { path: 'src/app.ts', diff: '@@ -3,2 +3,2 @@\n x\n-a\n+b', added: 1, removed: 1 },
            ],
          },
        },
      ],
    },
  });
  const group = container.querySelector<HTMLDetailsElement>('.chat-activity-group > details');
  expect(group?.open).toBe(false);
  expect(button('Review changes ↗').closest('details')).toBeNull();
  await act(() => group?.querySelector('summary')?.click());
  expect(group?.open).toBe(true);
  const rows = container.querySelectorAll<HTMLDetailsElement>('.chat-tool');
  expect(rows[0].open).toBe(false);
  expect(rows[1].open).toBe(false);
  await act(() => rows[1].querySelector('summary')?.click());
  expect(rows[1].open).toBe(true);
  expect(rows[0].querySelector('.chat-command')?.textContent).toBe('$ npm test\n1 passed');
  const lines = Array.from(rows[1].querySelectorAll('.chat-diff-line'), (line) => ({
    kind: line.getAttribute('data-kind'),
    numbers: Array.from(line.querySelectorAll('.chat-diff-number'), (n) => n.textContent),
  }));
  expect(lines).toEqual([
    { kind: 'hunk', numbers: ['', ''] },
    { kind: 'context', numbers: ['3', '3'] },
    { kind: 'del', numbers: ['4', ''] },
    { kind: 'add', numbers: ['', '4'] },
  ]);
  expect(container.querySelector('.chat-activity-summary .chat-diff-stat')?.textContent).toBe(
    '+1 −1',
  );
  await act(() => button('Review diff').click());
  expect(onReview).toHaveBeenCalledWith('src/app.ts');
});

it('offers a published tour beside the tool run that published it', async () => {
  const onOpenTour = vi.fn();
  const publish = (id: string, label: string, status: 'running' | 'completed' | 'failed') => ({
    id,
    kind: 'tool' as const,
    text: '',
    activity: { type: 'tool' as const, label, status },
  });
  const withItems = (items: ChatItem[]) => ({ ...props.state, items });
  await update({
    onOpenTour,
    state: withItems([publish('t', 'mcp__parallel-code__tour_publish', 'running')]),
  });
  expect(container.textContent).not.toContain('Open tour');
  await update({
    onOpenTour,
    state: withItems([publish('t', 'mcp__parallel-code__tour_publish', 'failed')]),
  });
  expect(container.textContent).not.toContain('Open tour');
  // Codex labels MCP calls as `server / tool`.
  await update({
    onOpenTour,
    state: withItems([publish('t', 'parallel-code / tour_publish', 'completed')]),
  });
  expect(button('Open tour ↗').closest('details')).toBeNull();
  await act(() => button('Open tour ↗').click());
  expect(onOpenTour).toHaveBeenCalledOnce();
  // Only the newest publish is held, so an earlier run must not offer it.
  await update({
    onOpenTour,
    state: withItems([
      publish('t', 'mcp__parallel-code__tour_publish', 'completed'),
      { id: 'a', kind: 'assistant', text: 'Published.' },
      publish('u', 'mcp__parallel-code__tour_publish', 'completed'),
    ]),
  });
  const groups = container.querySelectorAll('.chat-activity-group');
  expect(groups[0].textContent).not.toContain('Open tour');
  expect(groups[1].textContent).toContain('Open tour');
  await update({
    onOpenTour: undefined,
    state: withItems([publish('t', 'mcp__parallel-code__tour_publish', 'completed')]),
  });
  expect(container.textContent).not.toContain('Open tour');
});

it('leaves a settled, highlighted answer alone while the agent works on', async () => {
  const answer = { id: 'a', kind: 'assistant' as const, text: 'Run:\n\n```ts\nconst a = 1;\n```' };
  await update({ state: { ...props.state, items: [...props.state.items, answer] } });
  await vi.waitFor(() => expect(container.querySelector('.chat-markdown [style]')).not.toBeNull());
  const markdown = container.querySelector('.chat-markdown');
  // A marker survives only if the view never rewrites this message's HTML.
  markdown?.append(document.createElement('mark'));
  for (const text of ['Now', 'Now more', 'Now more text'])
    await update({
      state: {
        ...props.state,
        status: 'working',
        items: [...props.state.items, answer, { id: 'b', kind: 'assistant', text }],
      },
    });
  await update({ state: { ...props.state, status: 'ready' } });
  expect(markdown?.isConnected).toBe(true);
  expect(markdown?.querySelector('mark')).not.toBeNull();
});

it('keeps an edit group closed once the reader closes it, even after a declined edit', async () => {
  const edit = (id: string, status: 'running' | 'declined') => ({
    id,
    kind: 'tool' as const,
    text: '',
    activity: {
      type: 'files' as const,
      files: ['a.ts'],
      label: 'a.ts',
      status,
      diffs: [{ path: 'a.ts', diff: '-a\n+b', added: 1, removed: 1 }],
    },
  });
  const working = { ...props.state, status: 'working' as const };
  await update({ state: { ...working, items: [...working.items, edit('e1', 'running')] } });
  const group = container.querySelector<HTMLDetailsElement>('.chat-activity-group > details');
  expect(group?.open).toBe(false);
  await act(() => group?.querySelector('summary')?.click());
  expect(group?.open).toBe(true);
  await act(() => group?.querySelector('summary')?.click());
  await update({ state: { ...working, items: [...working.items, edit('e1', 'declined')] } });
  await update({
    state: { ...working, items: [...working.items, edit('e1', 'declined'), edit('e2', 'running')] },
  });
  expect(group?.open).toBe(false);
});

it('puts a message that failed after the view closed back for the next view', async () => {
  let fail: (error: Error) => void = () => {};
  send.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
  await drop([screenshot()]);
  await act(() => button('Send message').click());
  expect(props.draft).toBe('');
  expect(container.querySelector('.chat-context-chips')?.textContent ?? '').not.toContain(
    'screen.png',
  );
  dispose?.();
  await act(() => fail(new Error('Disconnected')));
  expect(props.draft).toBe('Keep my draft');
  mount();
  await settle();
  expect(composer().value).toBe('Keep my draft');
  expect(container.querySelector('.chat-context-chips')?.textContent).toContain('screen.png');
});

it('keeps the chosen model selected when the model list grows in place', async () => {
  const model = (id: string) => ({
    model: id,
    displayName: id,
    supportedReasoningEfforts: [],
  });
  await update({ state: { ...props.state, model: 'model-b', models: [model('model-a')] } });
  await update({
    state: { ...props.state, model: 'model-b', models: [model('model-a'), model('model-b')] },
  });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Model"]')?.value).toBe('model-b');
});

it('finds a command and the lines an edit changed, even with the rows closed', async () => {
  await update({
    state: {
      ...props.state,
      items: [
        {
          id: 'run',
          kind: 'tool',
          text: '1 passed',
          activity: {
            type: 'command',
            command: 'npm run lint',
            label: 'lint',
            status: 'completed',
          },
        },
        {
          id: 'edit',
          kind: 'tool',
          text: '',
          activity: {
            type: 'files',
            files: ['src/app.ts'],
            label: 'src/app.ts',
            status: 'completed',
            diffs: [{ path: 'src/app.ts', diff: '-old\n+return needle;', added: 1, removed: 1 }],
          },
        },
      ],
    },
  });
  await act(() => button('Search conversation').click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search conversation"]');
  if (!input) throw new Error('Missing search field');
  const search = (text: string) =>
    act(() => {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const results = () =>
    Array.from(container.querySelectorAll('.chat-search-results button'), (b) => b.textContent);
  await search('run lint');
  expect(results()).toEqual([expect.stringContaining('npm run lint')]);
  await search('needle');
  expect(results()).toEqual([expect.stringContaining('return needle;')]);
});

it('copies a message from its icon button and confirms it', async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await act(() => button('Copy message').click());
  expect(writeText).toHaveBeenCalledWith('Earlier prompt');
  expect(button('Copied').querySelector('svg')).not.toBeNull();
  expect(container.textContent).not.toContain('Use as new prompt');
});

it('copies a code block from its own button', async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await update({
    state: {
      ...props.state,
      items: [
        ...props.state.items,
        { id: 'a', kind: 'assistant', text: 'Run:\n\n```sh\nnpm run lint\nnpm test\n```\n' },
      ],
    },
  });
  await act(() => button('Copy code').click());
  expect(writeText).toHaveBeenCalledWith('npm run lint\nnpm test');
  // The answer counts as streaming again once the agent works on, before new text.
  await update({ state: { ...props.state, status: 'working' } });
  expect(container.querySelectorAll('.chat-code')).toHaveLength(0);
  await update({ state: { ...props.state, status: 'ready' } });
  expect(container.querySelectorAll('.chat-code')).toHaveLength(1);
  expect(container.querySelectorAll('.chat-code [aria-label="Copy code"]')).toHaveLength(1);
});

it('keeps declined and interrupted outcomes visible in a collapsed activity summary', async () => {
  await update({
    state: {
      ...props.state,
      items: [
        {
          id: 'declined',
          kind: 'tool',
          text: '',
          activity: {
            type: 'tool',
            label: 'Read private.ts',
            files: ['private.ts'],
            status: 'declined',
          },
        },
        {
          id: 'stopped',
          kind: 'tool',
          text: '',
          activity: { type: 'command', label: 'npm test', status: 'interrupted' },
        },
      ],
    },
  });
  const group = container.querySelector<HTMLDetailsElement>('.chat-activity-group > details');
  expect(group?.open).toBe(false);
  const summary = group?.querySelector('.chat-activity-summary');
  expect(summary?.textContent).toContain('1 declined');
  expect(summary?.textContent).toContain('1 stopped');
  expect(summary?.textContent).not.toContain('inspected');
});

it('keeps a dismissed failure group closed until another operation fails', async () => {
  const failed = {
    id: 'failed',
    kind: 'tool' as const,
    text: 'Command failed',
    activity: { type: 'command' as const, label: 'npm test', status: 'failed' as const },
  };
  const command = {
    id: 'next',
    kind: 'tool' as const,
    text: '',
    activity: { type: 'command' as const, label: 'npm run check', status: 'running' as const },
  };
  await update({ state: { ...props.state, items: [failed] } });
  const group = container.querySelector<HTMLDetailsElement>('.chat-activity-group > details');
  expect(group?.open).toBe(true);
  await act(() => group?.querySelector('summary')?.click());
  await update({ state: { ...props.state, items: [failed, command] } });
  expect(group?.open).toBe(false);
  expect(group?.querySelector('.chat-current-operation')?.textContent).toContain(
    'Running · npm run check',
  );
  await update({
    state: {
      ...props.state,
      items: [failed, { ...command, activity: { ...command.activity, status: 'failed' } }],
    },
  });
  expect(group?.open).toBe(true);
});

it('includes uncategorized tool work alongside file and command summaries', async () => {
  await update({
    state: {
      ...props.state,
      items: [
        {
          id: 'read',
          kind: 'tool',
          text: '',
          activity: { type: 'tool', label: 'Read app.ts', files: ['app.ts'], status: 'completed' },
        },
        {
          id: 'lookup',
          kind: 'tool',
          text: '',
          activity: { type: 'tool', label: 'Search documentation', status: 'completed' },
        },
      ],
    },
  });
  expect(container.querySelector('.chat-activity-label')?.textContent).toBe(
    '1 file inspected · 1 other operation',
  );
});

it('runs a ! draft as a shell command and keeps attachments for the next message', async () => {
  const shell = vi.fn(async () => {});
  await update({ draft: '', onShell: shell });
  expect(composer().placeholder).toContain('! for a shell command');
  await drop([screenshot()]);
  await type('!git status');
  expect(composer().closest('.chat-composer')?.classList.contains('chat-composer-shell')).toBe(
    true,
  );
  // Entering shell mode must not add a row: the composer never jumps.
  expect(container.querySelector('.chat-composer-status')).toBeNull();
  expect(button('Run command').title).toContain('Claude answers its output');
  await act(() => button('Run command').click());
  expect(shell).toHaveBeenCalledWith('git status');
  expect(send).not.toHaveBeenCalled();
  expect(composer().value).toBe('');
  // A command appears in the log once it starts; no sending copy stands in for it.
  expect(container.querySelector('.chat-user-sending')).toBeNull();
  expect(container.querySelector('img')).not.toBeNull();
});

it('shows the ! as a prompt beside the command, and Backspace before it leaves shell mode', async () => {
  await update({ draft: '', onShell: vi.fn(async () => {}) });
  await type('!');
  const prompt = () => container.querySelector('.chat-shell-prompt');
  expect(prompt()?.textContent).toBe('!');
  expect(composer().value).toBe('');
  await type('ls');
  expect(composer().value).toBe('ls');
  expect(props.draft).toBe('!ls');
  composer().setSelectionRange(0, 0);
  expect(press('Backspace')).toBe(false);
  await settle();
  expect(props.draft).toBe('ls');
  expect(prompt()).toBeNull();
  expect(composer().value).toBe('ls');
});

it('keeps the caret on the command when a ! is typed before it', async () => {
  await update({ draft: 'ls -la', onShell: vi.fn(async () => {}) });
  const input = composer();
  input.value = '!ls -la';
  input.setSelectionRange(1, 1);
  await act(() => input.dispatchEvent(new InputEvent('input', { data: '!', bubbles: true })));
  expect(props.draft).toBe('!ls -la');
  expect(input.value).toBe('ls -la');
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 0]);
});

it('shows only the command for a ! draft with leading space or a second bang', async () => {
  await update({ draft: '  !ls', onShell: vi.fn(async () => {}) });
  expect(composer().value).toBe('ls');
  await update({ draft: '!!x' });
  expect(composer().value).toBe('!x');
  composer().setSelectionRange(0, 0);
  press('Backspace');
  await settle();
  // One bang per Backspace, as in the terminal; `!x` is still a command.
  expect(props.draft).toBe('!x');
  expect(composer().value).toBe('x');
});

it('leaves shell mode on Backspace only with the caret at the start and no composition', async () => {
  await update({ draft: '!ls', onShell: vi.fn(async () => {}) });
  composer().setSelectionRange(0, 2);
  expect(press('Backspace')).toBe(true);
  composer().setSelectionRange(0, 0);
  expect(press('Backspace', { isComposing: true })).toBe(true);
  await settle();
  expect(props.draft).toBe('!ls');
});

it('queues a ! command while the agent works and runs it once it is ready', async () => {
  const shell = vi.fn(async () => {});
  await update({
    draft: '!npm test',
    onShell: shell,
    state: { ...props.state, status: 'working' },
  });
  await act(() => button('Queue command').click());
  expect(container.querySelector('[aria-label="Queued messages"]')?.textContent).toContain(
    '!npm test',
  );
  expect(shell).not.toHaveBeenCalled();
  await update({ state: { ...props.state, status: 'ready' } });
  expect(shell).toHaveBeenCalledWith('npm test');
});

it('sends a ! message to the agent when the chat cannot run commands', async () => {
  await update({ draft: '!important' });
  expect(composer().closest('.chat-composer')?.classList.contains('chat-composer-shell')).toBe(
    false,
  );
  await act(() => enter());
  expect(send).toHaveBeenCalledWith('!important', []);
});

it('shows a command the user ran with its output, apart from agent activity', async () => {
  await update({
    state: {
      ...props.state,
      items: [
        ...props.state.items,
        {
          id: 's',
          kind: 'shell',
          text: 'boom',
          activity: {
            type: 'command',
            label: 'make',
            command: 'make',
            status: 'failed',
            exitCode: 2,
          },
        },
      ],
    },
  });
  const turn = container.querySelector('.chat-shell-turn');
  expect(turn?.querySelector('.chat-speaker')?.textContent).toBe('You · Shell · Failed · exit 2');
  expect(turn?.querySelector('pre')?.textContent).toBe('$ make\nboom');
  expect(container.querySelector('.chat-tool')).toBeNull();
});

it('names Stop for the command while one runs', async () => {
  await update({
    state: {
      ...props.state,
      status: 'working',
      items: [
        {
          id: 's',
          kind: 'shell',
          text: '',
          activity: { type: 'command', label: 'sleep 9', command: 'sleep 9', status: 'running' },
        },
      ],
    },
  });
  expect(button('Stop command')).toBeDefined();
});

it('offers no Run for a ! with no command after it', async () => {
  await update({ draft: '!', onShell: vi.fn(async () => {}) });
  expect(button('Run command').disabled).toBe(true);
  await update({ draft: '!ls' });
  expect(button('Run command').disabled).toBe(false);
});

it('brings a command the user starts into view', async () => {
  await update({ draft: '', onShell: vi.fn(async () => {}) });
  const log = container.querySelector<HTMLElement>('.chat-scroll');
  if (!log) throw new Error('Missing log');
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 900 });
  log.scrollTop = 0;
  await update({
    state: {
      ...props.state,
      status: 'working',
      items: [
        ...props.state.items,
        {
          id: 's',
          kind: 'shell',
          text: '',
          activity: { type: 'command', label: 'ls', command: 'ls', status: 'running' },
        },
      ],
    },
  });
  expect(log.scrollTop).toBe(900);
});
