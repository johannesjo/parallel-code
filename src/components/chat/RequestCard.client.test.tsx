import { render } from 'solid-js/web';
import { Show, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestCard } from './RequestCard';
import type { ChatRequest } from '../../../electron/shared/agent-chat-types';

let host: HTMLDivElement;
let composer: HTMLTextAreaElement;
let container: HTMLDivElement;
let dispose: () => void;
let shown: (next: { request: ChatRequest; autoFocus: boolean } | undefined) => void;
const respond = vi.fn(async () => undefined);
const onResolved = vi.fn(() => composer.focus());
const approval = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  id: 7,
  since: 1,
  kind: 'approval',
  text: 'Run npm test?',
  ...overrides,
});
const question = (): ChatRequest =>
  approval({
    kind: 'question',
    text: 'Claude needs your input',
    questions: [
      {
        id: 'scope',
        question: 'Which scope?',
        isSecret: false,
        options: [{ label: 'Narrow', description: 'Only this file' }],
      },
    ],
  });
const focused = () => document.activeElement?.textContent;
// An option's first text is its label; its description follows.
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label || node.firstChild?.textContent === label,
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function act(action: () => unknown) {
  await action();
  await settle();
}
/** Shows the card; the same request object keeps its card, as the store's reconcile does. */
async function show(request: ChatRequest, autoFocus = true) {
  await act(() => shown({ request, autoFocus }));
}
const hide = () => act(() => shown(undefined));

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  host.className = 'chat-ui';
  container = document.createElement('div');
  composer = document.createElement('textarea');
  host.append(container, composer);
  const [current, setCurrent] = createSignal<{ request: ChatRequest; autoFocus: boolean }>();
  shown = setCurrent;
  dispose = render(
    () => (
      <Show when={current()?.request} keyed>
        {(request) => (
          <RequestCard
            request={request}
            respond={respond}
            agentName="Claude"
            autoFocus={current()?.autoFocus ?? false}
            onResolved={onResolved}
          />
        )}
      </Show>
    ),
    container,
  );
});
afterEach(() => {
  dispose();
  host.remove();
});

const twoQuestions = (): ChatRequest =>
  approval({
    kind: 'question',
    text: 'Claude needs your input',
    questions: [
      {
        id: 'scope',
        question: 'Which scope?',
        isSecret: false,
        options: [
          { label: 'Narrow', description: '' },
          { label: 'Wide', description: '' },
        ],
      },
      {
        id: 'tests',
        question: 'Add tests?',
        isSecret: false,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      },
    ],
  });

describe('approval card keyboard handling', () => {
  it('leaves focus in an external input, including an empty dialog input', async () => {
    const outside = document.createElement('input');
    document.body.append(outside);
    try {
      outside.focus();
      await show(approval());
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it('does not focus an approval behind a modal even if its input has not focused yet', async () => {
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    try {
      composer.focus();
      await show(approval());
      expect(document.activeElement).toBe(composer);
    } finally {
      modal.remove();
    }
  });

  it('restores focus when the state update removes the card before IPC resolves', async () => {
    let release = () => {};
    respond.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    await show(approval());
    await act(() => button('Allow once')?.click());
    await hide();
    await act(() => release());
    expect(onResolved).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(composer);
  });

  it('does not restore focus after removal if the user moved to another input', async () => {
    let release = () => {};
    respond.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    await show(approval());
    await act(() => button('Allow once')?.click());
    await hide();
    composer.focus();
    await act(() => release());
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('opens on Allow once so Enter approves, then hands the keyboard back', async () => {
    await show(approval());
    expect(focused()).toBe('Allow once');
    expect(button('Allow once')?.className).toContain('chat-request-default');
    // A focused button is what makes Enter mean "allow"; prove it reaches respond.
    await act(() => (document.activeElement as HTMLButtonElement).click());
    expect(respond).toHaveBeenCalledWith(approval(), 'accept', {});
    expect(onResolved).toHaveBeenCalled();
  });

  it('opens on Decline when the agent forbids a one-keystroke approval', async () => {
    await show(approval({ defaultToNo: true }));
    expect(focused()).toBe('Decline');
    expect(button('Decline')?.className).toContain('chat-request-default');
    expect(button('Allow once')?.className).not.toContain('chat-request-default');
  });

  it('leaves the keyboard alone for a chat the user is not working in', async () => {
    composer.focus();
    await show(approval(), false);
    expect(document.activeElement).toBe(composer);
  });

  it('never pulls the caret out of a half-written message', async () => {
    composer.value = 'also please check the';
    composer.focus();
    await show(approval());
    expect(document.activeElement).toBe(composer);
    // The card still marks its default, so Enter in the card means allow once.
    expect(button('Allow once')?.className).toContain('chat-request-default');
  });

  it('takes focus from an empty composer, which is how a chat panel idles', async () => {
    // Focusing the composer is how the app hands this panel the keyboard, so an
    // empty focused composer must not be mistaken for the user typing.
    composer.focus();
    await show(approval());
    expect(focused()).toBe('Allow once');
  });

  it('keeps the keyboard where the user moved it during the response round-trip', async () => {
    let release = () => {};
    respond.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    await show(approval());
    await act(() => (document.activeElement as HTMLButtonElement).click());
    composer.focus(); // The user clicked away while the IPC call was in flight.
    await act(() => {
      release();
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
  });

  it('does not re-grab focus when an older request resolves ahead of it', async () => {
    const request = approval();
    await show(request, false);
    const decline = button('Decline');
    decline?.focus();
    // The card ahead of this one resolved, so this one becomes the first request.
    await show(request, true);
    expect(document.activeElement).toBe(decline);
  });

  it('starts a question on its first answer control instead of a default choice', async () => {
    await show(question());
    expect(document.activeElement).toBe(button('Narrow'));
    expect(button('Submit answers')?.disabled).toBe(true);
  });
});

describe('choosing with arrow keys and Enter', () => {
  /** Dispatches like a keyboard does; returns whether the browser default still runs. */
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    document.activeElement?.dispatchEvent(event);
    await settle();
    return !event.defaultPrevented;
  };

  it('walks the approval choices with arrow keys, wrapping at the ends', async () => {
    await show(approval());
    await press('ArrowRight');
    expect(focused()).toBe('Decline');
    await press('ArrowDown');
    expect(focused()).toBe('Allow once');
    await press('ArrowUp');
    expect(focused()).toBe('Decline');
  });

  it('answers a single question with arrows and one Enter', async () => {
    await show(question());
    expect(await press('Enter')).toBe(false);
    expect(respond).toHaveBeenCalledWith(question(), 'accept', { scope: 'Narrow' });
  });

  it('moves to the next open question, then sends once every question is answered', async () => {
    const request = twoQuestions();
    await show(request);
    await press('ArrowDown');
    expect(focused()).toBe('Wide');
    await press('Enter');
    expect(respond).not.toHaveBeenCalled();
    expect(focused()).toBe('Yes');
    await press('ArrowRight');
    await press('Enter');
    expect(respond).toHaveBeenCalledWith(request, 'accept', { scope: 'Wide', tests: 'No' });
  });

  it('moves on to a question that only takes typed text', async () => {
    const request = twoQuestions();
    request.questions = [
      ...(request.questions?.slice(0, 1) ?? []),
      { id: 'why', question: 'Why?', isSecret: false, options: [] },
    ];
    await show(request);
    await press('Enter');
    expect(respond).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container.querySelectorAll('input')[1]);
  });

  it('moves from a single choice to an open multi-select instead of sending', async () => {
    const request = twoQuestions();
    request.questions = request.questions?.map((q, index) => ({ ...q, multiSelect: index === 1 }));
    await show(request);
    await press('Enter');
    expect(respond).not.toHaveBeenCalled();
    expect(focused()).toBe('Yes');
  });

  it('leaves Enter native on a multi-select so it toggles instead of sending', async () => {
    const request = twoQuestions();
    request.questions = request.questions?.map((q) => ({ ...q, multiSelect: true }));
    await show(request);
    expect(await press('Enter')).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    expect(container.querySelector('.chat-request-hint')?.textContent).toBe(
      'Arrow keys move, Enter toggles',
    );
  });

  it('leaves modified arrows to the app, where Alt+Arrow switches panes', async () => {
    await show(approval());
    expect(await press('ArrowRight', { altKey: true })).toBe(true);
    expect(focused()).toBe('Allow once');
  });

  it('does not let a held Enter rush through every question', async () => {
    await show(twoQuestions());
    await press('Enter');
    expect(focused()).toBe('Yes');
    // Auto-repeat must neither pick nor fall through to a native click.
    expect(await press('Enter', { repeat: true })).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(button('Yes')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps arrow keys for the caret in a typed answer', async () => {
    await show(question());
    container.querySelector('input')?.focus();
    expect(await press('ArrowLeft')).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('input'));
  });
});

describe('choosing with the mouse', () => {
  const field = (index = 0) => container.querySelectorAll('input')[index];
  async function type(text: string, index = 0) {
    const input = field(index);
    input.value = text;
    await act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
  }

  it('marks a choice on click and leaves sending to Submit', async () => {
    const request = twoQuestions();
    await show(request);
    await act(() => button('Wide')?.click());
    await act(() => button('No')?.click());
    // A stray click or tap must never send; the user confirms with Submit.
    expect(respond).not.toHaveBeenCalled();
    expect(button('Wide')?.getAttribute('aria-pressed')).toBe('true');
    expect(field().value).toBe('');
    await act(() => button('Submit answers')?.click());
    expect(respond).toHaveBeenCalledWith(request, 'accept', { scope: 'Wide', tests: 'No' });
  });

  it('lets a later click change a choice before sending', async () => {
    const request = question();
    request.questions = request.questions?.map((q) => ({
      ...q,
      options: [...q.options, { label: 'Wide', description: '' }],
    }));
    await show(request);
    await act(() => button('Narrow')?.click());
    await act(() => button('Wide')?.click());
    expect(button('Narrow')?.getAttribute('aria-pressed')).toBe('false');
    expect(respond).not.toHaveBeenCalled();
    await act(() => button('Submit answers')?.click());
    expect(respond).toHaveBeenCalledWith(request, 'accept', { scope: 'Wide' });
  });

  it('lets a typed answer replace a single choice instead of adding to it', async () => {
    const request = twoQuestions();
    await show(request);
    await act(() => button('Wide')?.click());
    await type('Only the parser');
    expect(button('Wide')?.getAttribute('aria-pressed')).toBe('false');
    await act(() => button('No')?.click());
    await act(() => button('Submit answers')?.click());
    expect(respond).toHaveBeenCalledWith(request, 'accept', {
      scope: 'Only the parser',
      tests: 'No',
    });
  });

  it('lets a clicked option replace a typed single answer', async () => {
    const request = twoQuestions();
    await show(request);
    await type('Only the parser');
    await act(() => button('Narrow')?.click());
    expect(field().value).toBe('');
    await act(() => button('Yes')?.click());
    await act(() => button('Submit answers')?.click());
    expect(respond).toHaveBeenCalledWith(request, 'accept', { scope: 'Narrow', tests: 'Yes' });
  });

  it('keeps a typed extra next to the ticked options of a multi-select', async () => {
    const request = twoQuestions();
    request.questions = request.questions?.map((q) => ({ ...q, multiSelect: true }));
    await show(request);
    await type('Docs too');
    await act(() => button('Narrow')?.click());
    await act(() => button('Wide')?.click());
    await act(() => button('Narrow')?.click());
    expect(field().value).toBe('Docs too');
    await act(() => button('Yes')?.click());
    expect(respond).not.toHaveBeenCalled();
    await act(() => button('Submit answers')?.click());
    expect(respond).toHaveBeenCalledWith(request, 'accept', {
      scope: 'Wide, Docs too',
      tests: 'Yes',
    });
  });

  it('sends a typed secret exactly as entered', async () => {
    const request = approval({
      kind: 'question',
      questions: [{ id: 'token', question: 'Token?', isSecret: true, options: [] }],
    });
    await show(request);
    await type('  pass phrase ');
    await act(() => button('Submit answers')?.click());
    expect(respond).toHaveBeenCalledWith(request, 'accept', { token: '  pass phrase ' });
  });

  it('shows what each option means on the card, not only in a tooltip', async () => {
    await show(question());
    expect(button('Narrow')?.textContent).toContain('Only this file');
  });
});

describe('approval card contents', () => {
  it('offers Always allow only when the agent said this ask can be remembered', async () => {
    await show(approval());
    expect(button('Always allow')).toBeUndefined();
    const remembered = approval({
      canAlwaysAllow: true,
      alwaysAllowNote: 'always allow Bash(npm test:*) in this checkout’s local settings',
    });
    await show(remembered);
    // Remembering is never one keystroke away: Enter still allows once.
    expect(focused()).toBe('Allow once');
    // What it writes is on the card, not only in a tooltip.
    expect(container.querySelector('.chat-request-note')?.textContent).toContain(
      'this checkout’s local settings',
    );
    await act(() => button('Always allow')?.click());
    expect(respond).toHaveBeenCalledWith(remembered, 'accept-always', {});
  });

  it('does not pick an option when the question text is clicked', async () => {
    await show(question());
    const text = [...container.querySelectorAll<HTMLElement>('*')].find(
      (node) =>
        node.firstChild?.nodeType === Node.TEXT_NODE &&
        node.firstChild.textContent === 'Which scope?',
    );
    expect(text).toBeDefined();
    await act(() => text?.click());
    expect(button('Narrow')?.getAttribute('aria-pressed')).toBe('false');
    expect(button('Submit answers')?.disabled).toBe(true);
  });

  it('never offers to remember an answer to a question', async () => {
    await show({ ...question(), canAlwaysAllow: true, alwaysAllowNote: 'always allow Read' });
    expect(button('Always allow')).toBeUndefined();
    expect(container.querySelector('.chat-request-note')).toBeNull();
  });

  it('leads with the prompt sentence and keeps the raw arguments folded away', async () => {
    const request = approval({
      action: 'Run command',
      text: 'Claude wants to run npm test',
      details: 'Bash\n{\n  "command": "npm test"\n}',
    });
    await show(request);
    // Naming the action must not cost the card its "this is a gate" framing.
    expect(container.querySelector('strong')?.textContent).toBe('Approval needed: Run command');
    expect(container.querySelector('.chat-request-text')?.textContent).toBe(
      'Claude wants to run npm test',
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('pre')?.textContent).toContain('"command": "npm test"');
  });
});
