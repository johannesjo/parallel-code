import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { createUnderstandingTour } from '../lib/create-understanding-tour';
import { invoke } from '../lib/ipc';
import { renderMermaidIn } from '../lib/mermaid';
import { openFileInEditor } from '../lib/shell';
import { GIST_LABEL } from '../lib/understanding-tour';
import { UnderstandingTourDialog } from './UnderstandingTourDialog';
import { UnderstandButton } from './understanding/UnderstandButton';

const channels = vi.hoisted(
  () =>
    [] as {
      onmessage: ((message: { type: string; text?: string; exitCode?: number }) => void) | null;
      dispose: () => void;
    }[],
);
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  Channel: class {
    onmessage = null;
    dispose = vi.fn();
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock('../store/store', async () => {
  const { createStore } = await import('solid-js/store');
  const [store] = createStore({
    askCodeProvider: 'minimax',
    agentEnvFiles: {},
    editorCommand: 'code',
  });
  return { store };
});
vi.mock('../lib/mermaid', () => ({ renderMermaidIn: vi.fn() }));
vi.mock('../lib/shell', () => ({ openFileInEditor: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/log')>()),
  info: vi.fn(),
}));

function card(over: Record<string, unknown> = {}) {
  return { label: 'KEY DECISION', title: 'Title', body: 'Body text.', tone: 'neutral', ...over };
}
const TOUR_JSON = JSON.stringify({
  gist: card({ label: GIST_LABEL, title: 'Gist title', tone: 'important' }),
  cards: [
    card({ title: 'First card', refs: [{ filePath: 'electron/ipc/pty.ts', line: 189 }] }),
    card({
      title: 'Second card',
      tone: 'risk',
      diagram: { kind: 'text', source: 'PTY -> Buffer -> IPC' },
    }),
    card({
      title: 'Third card',
      diagram: { kind: 'mermaid', source: 'graph TD; A-->B' },
    }),
  ],
});
const BRANCH_JSON = JSON.stringify({
  cards: [card({ title: 'Deep one' }), card({ title: 'Deep two' })],
});

const disposers: (() => void)[] = [];
beforeEach(() => {
  vi.mocked(invoke).mockImplementation((() => Promise.resolve(undefined)) as typeof invoke);
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  channels.length = 0;
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
const panel = () => {
  const element = document.querySelector('[role="dialog"]');
  if (!element) throw new Error('Dialog is not open');
  return element;
};
const buttons = () => [...panel().querySelectorAll('button')];
function clickButton(label: string) {
  const button = buttons().find((candidate) => candidate.textContent?.includes(label));
  if (!button)
    throw new Error(`No button labelled ${label}: ${buttons().map((b) => b.textContent)}`);
  button.click();
}
/** The chrome around the card is icon-only, so it is found by its label. */
function iconButton(label: string) {
  const button = buttons().find((candidate) => candidate.getAttribute('aria-label') === label);
  if (!button)
    throw new Error(
      `No icon labelled ${label}: ${buttons().map((b) => b.getAttribute('aria-label'))}`,
    );
  return button;
}
const stackItems = () => [...panel().querySelectorAll<HTMLElement>('.understanding-stack-item')];
const stackTitles = () =>
  stackItems().map((item) => item.querySelector('.understanding-card-title')?.textContent);

/** The title of the card on screen; the cards stacked around it are only context. */
const currentTitle = () =>
  panel().querySelector('[aria-current="true"] .understanding-card-title')?.textContent;

function clickIcon(label: string) {
  iconButton(label).click();
}
const progressText = () => panel().querySelector('.understanding-progress')?.textContent ?? '';
const askInput = () => {
  const input = panel().querySelector<HTMLInputElement>('.understanding-ask-input');
  if (!input) throw new Error('Ask input is missing');
  return input;
};

const PLAN_INPUT = {
  kind: 'plan',
  taskName: 'Task',
  worktreePath: '/repo',
  planContent: '# Plan',
  subject: 'output buffering',
} as const;

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const onClose = vi.fn();
  const onReference = vi.fn();
  const onOpenFile = vi.fn();
  let controller: ReturnType<typeof createUnderstandingTour> | undefined;
  disposers.push(
    render(() => {
      controller = createUnderstandingTour();
      return (
        <UnderstandingTourDialog
          tour={controller}
          open={true}
          onClose={onClose}
          worktreePath="/repo"
          onReference={onReference}
          onOpenFile={onOpenFile}
        />
      );
    }, host),
  );
  if (!controller) throw new Error('Controller was not created');
  return { tour: controller, onClose, onReference, onOpenFile };
}

/** Mounts the dialog with a generated tour, on its first card: the gist. */
async function mountWithTour(response = TOUR_JSON) {
  const mounted = mount();
  void mounted.tour.generate(PLAN_INPUT);
  await flush();
  channels[0].onmessage?.({ type: 'chunk', text: response });
  channels[0].onmessage?.({ type: 'done', exitCode: 0 });
  await flush();
  return mounted;
}

describe('UnderstandingTourDialog', () => {
  it('shows progress, elapsed time and a cancel action while generating', async () => {
    const { tour } = mount();
    void tour.generate(PLAN_INPUT);
    await flush();
    // Nothing is on screen but the card, so the only heading is the hidden one
    // that gives the dialog its accessible name.
    expect(panel().querySelector('h1')?.className).toBe('dialog-sr-only');
    expect(panel().querySelector('h1')?.textContent).toBe('Understanding tour of output buffering');
    expect(panel().textContent).toContain('Generating tour…');
    expect(panel().querySelector('[role="status"]')?.textContent).toContain(
      'Waiting for provider · 0s',
    );
    channels[0].onmessage?.({ type: 'chunk', text: '{' });
    expect(panel().querySelector('[role="status"]')?.textContent).toContain('Receiving response');
    clickIcon('Cancel generation');
    expect(invoke).toHaveBeenCalledWith(IPC.CancelAskAboutCode, {
      requestId: expect.any(String),
    });
    expect(tour.loading()).toBe(false);
  });

  it('leaves only the close icon after a cancelled generation', async () => {
    const { tour, onClose } = mount();
    void tour.generate(PLAN_INPUT);
    await flush();
    clickIcon('Cancel generation');
    expect(tour.loading()).toBe(false);
    expect(panel().textContent).toContain('Generation cancelled.');
    // Cancelling was deliberate, so nothing offers another attempt here.
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual(['Close tour']);
    clickIcon('Close tour');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens on the gist as the first card of the spine', async () => {
    await mountWithTour();
    expect(panel().textContent).toContain('Gist title');
    expect(panel().textContent).toContain(GIST_LABEL);
    // The subject appears once, in the strip above the card, and never again.
    expect(progressText()).toContain('output buffering');
    // The gist is counted and navigable like every other card.
    expect(progressText()).toContain('1 / 4');
    const segments = panel().querySelectorAll('.understanding-segments > button');
    expect(segments).toHaveLength(4);
    expect(segments[0].getAttribute('aria-current')).toBe('step');
    expect(panel().querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(iconButton('Previous card').disabled).toBe(true);
    clickIcon('Next card');
    expect(panel().textContent).toContain('First card');
    expect(progressText()).toContain('2 / 4');
    // The gist stays one arrow key away instead of being left behind.
    clickIcon('Previous card');
    expect(panel().textContent).toContain('Gist title');
  });

  it('disables Previous on the first card and finishes on the last', async () => {
    const { onClose } = await mountWithTour();
    expect(iconButton('Previous card').disabled).toBe(true);
    clickIcon('Next card');
    clickIcon('Next card');
    expect(panel().textContent).toContain('Second card');
    expect(iconButton('Previous card').disabled).toBe(false);
    clickIcon('Next card');
    expect(panel().textContent).toContain('Third card');
    expect(progressText()).toContain('4 / 4');
    // The last card turns the way forward into the way out.
    expect(buttons().some((button) => button.getAttribute('aria-label') === 'Next card')).toBe(
      false,
    );
    expect(iconButton('Finish tour').title).toBe('Finish');
    clickIcon('Finish tour');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('marks the card tone and renders both diagram kinds', async () => {
    await mountWithTour();
    expect(panel().querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('important');
    clickIcon('Next card');
    clickIcon('Next card');
    const article = panel().querySelector('[data-tone]');
    expect(article?.getAttribute('data-tone')).toBe('risk');
    expect(panel().querySelector('.understanding-card-label')?.textContent).toContain('⚠');
    expect(panel().querySelector('pre.understanding-diagram')?.textContent).toBe(
      'PTY -> Buffer -> IPC',
    );
    expect(renderMermaidIn).not.toHaveBeenCalled();
    clickIcon('Next card');
    const block = panel().querySelector('.mermaid-block');
    expect(block?.getAttribute('data-mermaid')).toBe('graph TD; A-->B');
    // The source stays as text so a Mermaid failure leaves readable content.
    expect(block?.textContent).toBe('graph TD; A-->B');
    expect(renderMermaidIn).toHaveBeenCalledWith(block?.parentElement, 'understanding');
  });

  it('opens a code reference in the editor at its line', async () => {
    await mountWithTour();
    clickIcon('Next card');
    clickButton('electron/ipc/pty.ts:189');
    expect(openFileInEditor).toHaveBeenCalledWith('/repo', 'electron/ipc/pty.ts', {
      line: 189,
      editorCommand: 'code',
    });
  });

  it('asks a question from the ask bar and opens its answer as a card under the card', async () => {
    await mountWithTour();
    clickIcon('Next card');
    clickIcon('Next card');
    const input = askInput();
    input.value = 'Why buffer first?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(input.value).toBe('');
    expect(panel().querySelector('[role="status"]')?.textContent).toContain('Thinking…');
    // Where the answer will land shows at the card's foot and in the outline.
    expect(panel().querySelector('.tour-deeper-pending')?.textContent).toContain(
      'Why buffer first?',
    );
    expect(panel().querySelector('.tour-outline-pending')).not.toBeNull();
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(asks).toHaveLength(2);
    expect(asks[1][1]?.purpose).toBe('understand');
    expect(String(asks[1][1]?.prompt)).toContain('Why buffer first?');
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    // The answer is a card of its own, under the card it was asked on.
    expect(progressText()).toContain('3 / 4');
    expect(currentTitle()).toBe('Deep one');
    expect(panel().querySelector('.understanding-crumb button')?.textContent).toBe(
      '↳ Why buffer first?',
    );
    const outline = () =>
      [...panel().querySelectorAll('.understanding-aside .tour-outline-link')].map(
        (link) => link.textContent,
      );
    expect(outline()).toEqual([
      'Gist title',
      'First card',
      'Second card',
      'Deep one',
      'Deep two',
      'Third card',
    ]);
    expect(
      panel().querySelector('.understanding-aside [aria-current="location"]')?.textContent,
    ).toBe('Deep one');
    clickIcon('Next card');
    expect(currentTitle()).toBe('Deep two');
    // The crumb leads back to the card the answer belongs to, its answers below.
    panel().querySelector<HTMLButtonElement>('.understanding-crumb button')?.click();
    expect(currentTitle()).toBe('Second card');
    expect(panel().querySelector('.understanding-crumb button')).toBeNull();
    expect(stackTitles()).toEqual(['Second card', 'Deep one', 'Deep two']);
    expect(panel().querySelector('.tour-deeper-link')).toBeNull();
    stackItems()[2]?.click();
    expect(currentTitle()).toBe('Deep two');
  });

  it('goes into answers with the down arrow and back out with the up arrow', async () => {
    const { tour } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const key = (name: string) =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    expect(tour.currentNode()?.card.title).toBe('Deep one');
    expect(panel().querySelector('.understanding-crumb button')?.textContent).toBe(
      '↳ Deeper: First card',
    );
    key('ArrowUp');
    expect(tour.currentNode()?.card.title).toBe('First card');
    key('ArrowUp');
    expect(tour.currentNode()?.card.title).toBe('First card');
    key('ArrowDown');
    expect(tour.currentNode()?.card.title).toBe('Deep one');
    // Left and right go between the tour's own cards, from answers too.
    key('ArrowRight');
    expect(tour.currentNode()?.card.title).toBe('Second card');
    key('ArrowLeft');
    expect(tour.currentNode()?.card.title).toBe('First card');
    key('ArrowDown');
    key('ArrowLeft');
    expect(tour.currentNode()?.card.title).toBe('Gist title');
  });

  it('stacks the answers under the card they answer and opens one on click', async () => {
    await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const items = stackItems;
    const titles = stackTitles;
    expect(titles()).toEqual(['First card', 'Deep one', 'Deep two']);
    expect(currentTitle()).toBe('Deep one');
    // Only the card on screen takes clicks inside it; the others open on click.
    expect(items().map((item) => item.querySelector('article')?.inert)).toEqual([
      true,
      false,
      true,
    ]);
    items()[2]?.click();
    expect(currentTitle()).toBe('Deep two');
    expect(titles()).toEqual(['First card', 'Deep one', 'Deep two']);
  });

  it('steps down through every answer before the ask field, and back up', async () => {
    const { tour } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const key = (name: string) =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    expect(tour.currentNode()?.card.title).toBe('Deep one');
    key('ArrowDown');
    expect(tour.currentNode()?.card.title).toBe('Deep two');
    expect(document.activeElement).not.toBe(askInput());
    key('ArrowDown');
    expect(document.activeElement).toBe(askInput());
    askInput().blur();
    key('ArrowUp');
    expect(tour.currentNode()?.card.title).toBe('Deep one');
    key('ArrowUp');
    expect(tour.currentNode()?.card.title).toBe('First card');
  });

  it('pages the stack only through a card taller than it, not one still sliding in', async () => {
    const { tour } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const stack = panel().querySelector<HTMLElement>('.understanding-stack');
    const card = panel().querySelector<HTMLElement>('[aria-current="true"] > article');
    if (!stack || !card) throw new Error('no stack');
    const rect = (top: number, height: number) =>
      ({ top, bottom: top + height, height }) as DOMRect;
    stack.getBoundingClientRect = () => rect(0, 500);
    stack.scrollBy = vi.fn();
    let cardHeight = 800;
    // Half below the stack: a tall card read from its top, or a short one mid-slide.
    card.getBoundingClientRect = () => rect(300, cardHeight);
    const key = (name: string) =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));

    key('ArrowDown');
    expect(stack.scrollBy).toHaveBeenCalledTimes(1);
    expect(tour.currentNode()?.card.title).toBe('Deep one');

    cardHeight = 300;
    key('ArrowDown');
    expect(stack.scrollBy).toHaveBeenCalledTimes(1);
    expect(tour.currentNode()?.card.title).toBe('Deep two');
  });

  it('digs into one point of a slide and then opens that answer', async () => {
    const { tour } = await mountWithTour(
      JSON.stringify({
        gist: card({ body: '', points: ['Buffers flush on a timer', 'One message per flush'] }),
        cards: [card({ title: 'Next step' })],
      }),
    );
    const dig = () => [
      ...panel().querySelectorAll<HTMLButtonElement>('[aria-current] .understanding-point-dig'),
    ];
    expect(dig().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Go deeper on: Buffers flush on a timer',
      'Go deeper on: One message per flush',
    ]);
    dig()[0].click();
    await flush();
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(String(asks[1][1]?.prompt)).toContain(
      JSON.stringify('Go deeper on this point: Buffers flush on a timer'),
    );
    // One question at a time: the other point waits.
    expect(dig()[1].disabled).toBe(true);
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(panel().querySelector('.understanding-crumb button')?.textContent).toBe(
      '↳ Buffers flush on a timer',
    );
    // The card above, dimmed while its answer is read, still shows the point answered.
    const headPoints = panel().querySelectorAll('.understanding-stack-item:first-child li');
    expect([...headPoints].map((point) => point.hasAttribute('data-open'))).toEqual([true, false]);
    tour.leave();
    expect(dig()[0].getAttribute('aria-label')).toBe(
      'Open the answer on: Buffers flush on a timer',
    );
    expect(dig()[0].closest('li')?.hasAttribute('data-open')).toBe(true);
    dig()[0].click();
    await flush();
    expect(asks).toHaveLength(2);
    expect(tour.currentNode()?.card.title).toBe('Deep one');
  });

  it('explores a suggested question once and keeps its answer on the source card', async () => {
    const question = 'What happens if the buffer fills before the timer fires?';
    const { tour } = await mountWithTour(
      JSON.stringify({
        gist: card({ questions: [question, 'Why flush on a timer?'] }),
        cards: [card({ title: 'Next step', questions: [question] })],
      }),
    );
    const suggestions = () => [
      ...panel().querySelectorAll<HTMLButtonElement>('[aria-current] .tour-question'),
    ];
    expect(suggestions()).toHaveLength(2);
    suggestions()[0].click();
    suggestions()[1].click();
    await flush();
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(asks).toHaveLength(2); // Tour generation plus one follow-up.
    expect(String(asks[1][1]?.prompt)).toContain(JSON.stringify(question));
    expect(suggestions().every((button) => button.disabled)).toBe(true);
    clickIcon('Next card');
    expect(suggestions()[0].disabled).toBe(true);
    expect(panel().querySelector('.tour-deeper')).toBeNull();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    // The reader moved on, so the answer waits under its card instead.
    expect(currentTitle()).toBe('Next step');
    expect(suggestions()[0].disabled).toBe(false);
    clickIcon('Previous card');
    expect(suggestions().map((button) => button.textContent)).toEqual(['↳Why flush on a timer?']);
    expect(stackTitles()).toEqual(['Title', 'Deep one', 'Deep two']);
    expect(tour.currentNode()?.children[0]?.question).toBe(question);
  });

  it('keeps the waiting question under its own card while the reader moves on', async () => {
    await mountWithTour();
    clickIcon('Next card');
    const input = askInput();
    input.value = 'Why buffer first?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(panel().querySelector('.tour-deeper-pending')).not.toBeNull();
    clickIcon('Next card');
    expect(panel().querySelector('.tour-deeper')).toBeNull();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    // The answer belongs to the card it was asked from, so this card stays bare.
    expect(panel().querySelector('.tour-deeper')).toBeNull();
    expect(stackItems()).toHaveLength(1);
    clickIcon('Previous card');
    expect(stackTitles()).toEqual(['First card', 'Deep one', 'Deep two']);
  });

  it('keeps a question in flight visible and cancellable from another card', async () => {
    const { tour } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    expect(iconButton('Cancel question')).toBeDefined();
    clickIcon('Next card');
    // The field names the card being answered, so Cancel here is not mistaken
    // for cancelling something on this card.
    expect(askInput().disabled).toBe(true);
    expect(askInput().placeholder).toBe('Answering on “First card”…');
    expect(tour.asking()).toBe(true);
    iconButton('Cancel question').click();
    expect(tour.asking()).toBe(false);
  });

  it('focuses the primary action so arrow keys navigate from the start', async () => {
    await mountWithTour();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Next card');
    const focused = document.activeElement;
    expect(focused && panel().contains(focused)).toBe(true);
    focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(panel().textContent).toContain('First card');
    askInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(panel().textContent).toContain('First card');
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    expect(panel().textContent).toContain('Gist title');
  });

  it('navigates with arrow keys after a click on the card moved focus to the panel', async () => {
    await mountWithTour();
    const dialog = panel();
    if (!(dialog instanceof HTMLElement)) throw new Error('Dialog panel is not an element');
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(panel().textContent).toContain('First card');
  });

  it('moves focus to the ask field on Enter from the resting focus', async () => {
    await mountWithTour();
    const next = document.activeElement;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    next?.dispatchEvent(enter);
    expect(document.activeElement).toBe(askInput());
    // The default press of Next is suppressed, so the card stays.
    expect(enter.defaultPrevented).toBe(true);
    expect(panel().textContent).toContain('Gist title');

    const dialog = panel();
    if (!(dialog instanceof HTMLElement)) throw new Error('Dialog panel is not an element');
    dialog.focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.activeElement).toBe(askInput());
  });

  it('steps down into the ask field below the last card and back up out of it', async () => {
    const { tour } = await mountWithTour();
    const next = document.activeElement;
    const down = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    next?.dispatchEvent(down);
    expect(document.activeElement).toBe(askInput());
    expect(down.defaultPrevented).toBe(true);
    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    askInput().dispatchEvent(up);
    expect(document.activeElement).toBe(next);
    expect(up.defaultPrevented).toBe(true);
    expect(tour.currentNode()?.card.title).toBe('Gist title');
  });

  it('keeps the ask field on up while composing or selecting text', async () => {
    await mountWithTour();
    askInput().focus();
    for (const init of [{ isComposing: true }, { shiftKey: true }]) {
      const up = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true,
        ...init,
      });
      askInput().dispatchEvent(up);
      expect(document.activeElement).toBe(askInput());
      expect(up.defaultPrevented).toBe(false);
    }
  });

  it('leaves the down arrow alone while the ask field is closed', async () => {
    const { tour } = await mountWithTour();
    void tour.ask('Why?');
    await flush();
    const next = document.activeElement;
    const down = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    next?.dispatchEvent(down);
    expect(askInput().disabled).toBe(true);
    expect(document.activeElement).toBe(next);
    expect(down.defaultPrevented).toBe(false);
  });

  it('leaves Enter to other buttons in the tour', async () => {
    await mountWithTour();
    const deeper = iconButton('Go deeper');
    deeper.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    deeper.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(deeper);
  });

  it('jumps to a card from its progress segment and with Home and End', async () => {
    await mountWithTour();
    clickIcon('Card 4 of 4: Third card');
    expect(progressText()).toContain('4 / 4');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(panel().textContent).toContain('Gist title');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(panel().textContent).toContain('Third card');
  });

  it('shows the outline in place of the card and opens the one picked', async () => {
    await mountWithTour();
    clickIcon('Show outline');
    const links = [
      ...panel().querySelectorAll<HTMLButtonElement>(
        '.understanding-outline-card .tour-outline-link',
      ),
    ];
    expect(links.map((link) => link.textContent)).toEqual([
      'Gist title',
      'First card',
      'Second card',
      'Third card',
    ]);
    links[3].click();
    expect(panel().querySelector('.understanding-outline-card')).toBeNull();
    expect(progressText()).toContain('4 / 4');
  });

  it('opens a card from the outline beside it and folds branches on request', async () => {
    const { tour } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const aside = () => panel().querySelector('.understanding-aside');
    const titles = () =>
      [...(aside()?.querySelectorAll('.tour-outline-link') ?? [])].map((link) => link.textContent);
    // Away from the branch, it folds; its twisty opens it again.
    clickIcon('Card 4 of 4: Third card');
    expect(titles()).toEqual(['Gist title', 'First card', 'Second card', 'Third card']);
    aside()?.querySelector<HTMLButtonElement>('[aria-label="Expand First card"]')?.click();
    expect(titles()).toContain('Deep two');
    [...(aside()?.querySelectorAll<HTMLButtonElement>('.tour-outline-link') ?? [])]
      .find((link) => link.textContent === 'Deep two')
      ?.click();
    expect(tour.currentNode()?.card.title).toBe('Deep two');
    // The branch holding the card on screen stays open, and cannot be folded.
    expect(titles()).toContain('Deep two');
    expect(aside()?.querySelector('[aria-label="Collapse First card"]')).toBeNull();
  });

  it('marks the progress segment of a card that has answers', async () => {
    await mountWithTour();
    clickIcon('Next card');
    const input = askInput();
    input.value = 'Why?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const segments = panel().querySelectorAll('.understanding-segments > button');
    expect(segments[1].hasAttribute('data-answered')).toBe(true);
    expect(segments[1].getAttribute('aria-label')).toContain('(has answers)');
    expect(segments[0].hasAttribute('data-answered')).toBe(false);
  });

  it('keeps the dialog open when Escape is pressed while typing a question', async () => {
    const { onClose } = await mountWithTour();
    const input = askInput();
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    // The field lets go of focus, so a second Escape closes the tour as usual.
    expect(document.activeElement).not.toBe(input);
  });

  it('copies the tour as Markdown', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mountWithTour();
    clickIcon('Copy tour as Markdown');
    await flush();
    const markdown = String(writeText.mock.calls[0]?.[0 as never]);
    expect(markdown).toContain('# Tour: output buffering');
    expect(markdown).toContain('\n## Third card\n');
    expect(markdown).not.toContain('parallel-code-tour');
    expect(iconButton('Tour copied')).toBeDefined();
  });

  it('saves the tour to the worktree and shows that it is saved', async () => {
    const { tour, onOpenFile } = await mountWithTour();
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.SaveTourFile
        ? Promise.resolve('output-buffering.tour.md')
        : Promise.resolve(undefined)) as typeof invoke);
    clickIcon('Save tour');
    await flush();
    expect(tour.savedPath()).toBe('output-buffering.tour.md');
    // Saved is a state, not something left to press.
    expect(buttons().some((button) => button.getAttribute('aria-label') === 'Save tour')).toBe(
      false,
    );
    const saved = panel().querySelector<HTMLButtonElement>('.tour-save-state');
    expect(saved?.textContent).toBe('Saved · output-buffering.tour.md');
    expect(saved?.title).toContain('new answers update it');
    saved?.click();
    expect(onOpenFile).toHaveBeenCalledWith('output-buffering.tour.md');
  });

  it('says when new answers did not reach the file and saves them on retry', async () => {
    const { tour } = await mountWithTour();
    let failNext = false;
    vi.mocked(invoke).mockImplementation(((channel: IPC, args?: { path?: string }) => {
      if (channel !== IPC.SaveTourFile) return Promise.resolve(undefined);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(args?.path);
    }) as typeof invoke);
    clickIcon('Save tour');
    await flush();
    failNext = true;
    clickIcon('Go deeper');
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    await flush();
    const state = () => panel().querySelector<HTMLButtonElement>('.tour-save-state');
    expect(state()?.textContent).toBe('Not saved · Retry');
    state()?.click();
    await flush();
    await flush();
    expect(state()?.textContent).toBe('Saved · output-buffering.tour.md');
    expect(tour.unsaved()).toBe(false);
  });

  it('places an answer among its siblings and names a question still running elsewhere', async () => {
    await mountWithTour();
    clickIcon('Go deeper');
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const count = () => panel().querySelector('.understanding-crumb-count')?.textContent;
    expect(count()).toMatch(/^Answer 1 of \d+$/);
    clickIcon('Next card');
    // Back on a card with no answer above it, the line is empty but kept.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(count()).toBe('');
    clickIcon('Go deeper');
    await flush();
    clickIcon('Next card');
    expect(askInput().placeholder).toBe('Answering on “Gist title”…');
    expect(iconButton('Cancel question')).toBeDefined();
  });

  it('counts an answer among the answers to its own question', async () => {
    const { tour } = await mountWithTour();
    for (const [index, question] of ['First?', 'Second?'].entries()) {
      tour.navigate(0);
      void tour.ask(question);
      await flush();
      channels[index + 1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
      channels[index + 1].onmessage?.({ type: 'done', exitCode: 0 });
      await flush();
    }
    expect(panel().querySelector('.understanding-crumb button')?.textContent).toBe('↳ Second?');
    expect(panel().querySelector('.understanding-crumb-count')?.textContent).toBe('Answer 1 of 2');
  });

  it('explains a closed ask field at the deepest level and offers the chat', async () => {
    const { tour, onReference } = await mountWithTour();
    for (let level = 1; level < 5; level += 1) {
      void tour.ask(`Level ${level}?`);
      await flush();
      channels[level].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
      channels[level].onmessage?.({ type: 'done', exitCode: 0 });
      await flush();
    }
    expect(tour.askLimit()).toBe('depth');
    expect(askInput().placeholder).toBe('Deepest level reached · continue in chat');
    clickIcon('Continue in chat');
    expect(onReference).toHaveBeenCalledOnce();
  });

  it('returns focus to the way forward when a control inside the card moves on', async () => {
    await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const crumb = panel().querySelector<HTMLButtonElement>('.understanding-crumb button');
    crumb?.focus();
    crumb?.click();
    await flush();
    expect(currentTitle()).toBe('First card');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Next card');
  });

  it('hands the card on screen to the chat with its place in the tour', async () => {
    const { onReference } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Reference in chat');
    expect(onReference).toHaveBeenCalledOnce();
    const reference = String(onReference.mock.calls[0][0]);
    expect(reference).toContain('tour: output buffering');
    expect(reference).toContain('Position: First card');
    expect(reference).toContain('### First card');
  });

  it('sends the scratchpad notes to the chat and clears them', async () => {
    const { onReference } = await mountWithTour();
    const notes = panel().querySelector<HTMLTextAreaElement>('.understanding-aside textarea');
    if (!notes) throw new Error('Notes field is missing');
    expect(iconButton('Send notes to agent').disabled).toBe(true);
    notes.value = 'Buffers flush on exit.';
    notes.dispatchEvent(new InputEvent('input', { bubbles: true }));
    // Arrow keys in the notes move the caret, never the tour.
    notes.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(currentTitle()).toBe('Gist title');
    clickIcon('Send notes to agent');
    expect(onReference).toHaveBeenCalledOnce();
    const sent = String(onReference.mock.calls[0][0]);
    expect(sent).toContain('Notes from the tour: output buffering');
    expect(sent).toContain('Buffers flush on exit.');
    expect(notes.value).toBe('');
  });

  it('keeps notes across closing the tour, sends on Ctrl+Enter, and names their tour', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const onReference = vi.fn();
    const [open, setOpen] = createSignal(true);
    let controller: ReturnType<typeof createUnderstandingTour> | undefined;
    disposers.push(
      render(() => {
        controller = createUnderstandingTour();
        return (
          <UnderstandingTourDialog
            tour={controller}
            open={open()}
            onClose={() => setOpen(false)}
            worktreePath="/repo"
            onReference={onReference}
          />
        );
      }, host),
    );
    if (!controller) throw new Error('Controller was not created');
    void controller.generate(PLAN_INPUT);
    await flush();
    channels[0].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const notes = () => {
      const field = document.querySelector<HTMLTextAreaElement>('.understanding-aside textarea');
      if (!field) throw new Error('Notes field is missing');
      return field;
    };
    notes().value = 'Buffers flush on exit.';
    notes().dispatchEvent(new InputEvent('input', { bubbles: true }));
    setOpen(false);
    setOpen(true);
    expect(notes().value).toBe('Buffers flush on exit.');
    void controller.generate({ ...PLAN_INPUT, subject: 'another subject' });
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    notes().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    expect(onReference).toHaveBeenCalledOnce();
    expect(String(onReference.mock.calls[0][0])).toContain('Notes from the tour: output buffering');
  });

  it('reworks the tour from the rework bar; Escape closes only the bar', async () => {
    const { onClose } = await mountWithTour();
    clickIcon('Rework tour');
    const input = panel().querySelector<HTMLInputElement>('.tour-rework input');
    if (!input) throw new Error('Rework input is missing');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel().querySelector('.tour-rework')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    clickIcon('Rework tour');
    const again = panel().querySelector<HTMLInputElement>('.tour-rework input');
    if (!again) throw new Error('Rework input is missing');
    again.value = 'Only the risks';
    again.dispatchEvent(new Event('input', { bubbles: true }));
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(panel().textContent).toContain('Reworking tour…');
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(String(asks[1][1]?.prompt)).toContain('"Only the risks"');
  });

  it('offers Regenerate when a reopened file tour is out of date', async () => {
    let content = 'export const a = 1;';
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.ReadFileTourContext
        ? Promise.resolve({
            filePath: 'src/a.ts',
            files: [{ path: 'src/a.ts', content, truncated: false }],
            omitted: [],
          })
        : Promise.resolve(undefined)) as typeof invoke);
    const input = {
      kind: 'file',
      taskName: 'Task',
      worktreePath: '/repo',
      filePath: 'src/a.ts',
    } as const;
    const { tour } = mount();
    void tour.generate(input);
    await flush();
    channels[0].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(panel().querySelector('.understanding-notice')).toBeNull();
    content = 'export const a = 2;';
    tour.open(input);
    await flush();
    expect(panel().querySelector('.understanding-notice')?.textContent).toContain('changed');
    clickButton('Regenerate');
    await flush();
    expect(tour.loading()).toBe(true);
  });

  it('cancels a follow-up from the ask bar and ignores its late chunks', async () => {
    const { tour } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    expect(tour.asking()).toBe(true);
    clickIcon('Cancel question');
    expect(tour.asking()).toBe(false);
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(tour.tree()[1].children).toHaveLength(0);
    expect(panel().textContent).toContain('First card');
  });

  it('closes from the icon above the card on any state', async () => {
    const { onClose } = await mountWithTour();
    const close = panel().querySelector<HTMLButtonElement>('[aria-label="Close tour"]');
    expect(close).not.toBeNull();
    close?.click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows an alert and retries after a failed generation', async () => {
    const { tour } = mount();
    void tour.generate(PLAN_INPUT);
    await flush();
    channels[0].onmessage?.({ type: 'chunk', text: 'not json' });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(panel().querySelector('[role="alert"]')).not.toBeNull();
    clickIcon('Retry');
    await flush();
    expect(channels).toHaveLength(2);
    channels[1].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(panel().querySelector('[role="alert"]')).toBeNull();
    expect(panel().textContent).toContain('Gist title');
  });
});

describe('UnderstandButton', () => {
  function mountButton() {
    const host = document.createElement('div');
    document.body.append(host);
    const onClick = vi.fn();
    let controller: ReturnType<typeof createUnderstandingTour> | undefined;
    disposers.push(
      render(() => {
        controller = createUnderstandingTour();
        return (
          <UnderstandButton
            label="Understand"
            tour={controller}
            kind="plan"
            subject={PLAN_INPUT.subject}
            onClick={onClick}
          />
        );
      }, host),
    );
    if (!controller) throw new Error('Controller was not created');
    const button = host.querySelector('button');
    if (!button) throw new Error('Button is missing');
    return { tour: controller, onClick, button };
  }

  it('stays idle while the shared controller runs a different tour', async () => {
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.ReadFileTourContext
        ? Promise.resolve({
            filePath: 'src/pty.ts',
            files: [{ path: 'src/pty.ts', content: 'export const x = 1;', truncated: false }],
            omitted: [],
          })
        : Promise.resolve(undefined)) as typeof invoke);
    const { tour, onClick, button } = mountButton();
    void tour.generate({
      kind: 'file',
      taskName: 'Task',
      worktreePath: '/repo',
      filePath: 'src/pty.ts',
    });
    await flush();
    expect(tour.loading()).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.textContent).toBe('Understand');
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
    // The file tour belongs to another button, so this click must not cancel it.
    expect(tour.loading()).toBe(true);
  });

  it('moves through idle, generating, ready and error states', async () => {
    const { tour, onClick, button } = mountButton();
    expect(button.textContent).toBe('Understand');
    expect(button.getAttribute('aria-busy')).toBe('false');
    button.click();
    expect(onClick).toHaveBeenCalledOnce();

    void tour.generate(PLAN_INPUT);
    await flush();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.inline-spinner')).not.toBeNull();
    // One line only: the phase and elapsed time live in the hint.
    expect(button.textContent).toContain('Understand');
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const hint = () => document.querySelector('[role="tooltip"]')?.textContent ?? '';
    expect(hint()).toContain('Waiting for provider');
    expect(hint()).toContain('Click to cancel.');
    button.click();
    expect(tour.loading()).toBe(false);
    expect(onClick).toHaveBeenCalledOnce();

    void tour.generate(PLAN_INPUT);
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: 'not json' });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(button.textContent).toBe('Retry');

    void tour.generate(PLAN_INPUT);
    await flush();
    channels[2].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    channels[2].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(button.querySelector('[aria-label="Tour ready"]')).not.toBeNull();
    expect(button.textContent).toContain('Understand');
    expect(hint()).toContain('Click to open it.');
  });
});
