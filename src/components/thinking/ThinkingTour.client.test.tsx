import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MindMapDocument } from '../../../electron/shared/mindmap';
import { createUnderstandingTour } from '../../lib/create-understanding-tour';
import { startUnderstandingRequest } from '../../lib/understanding-request';
import { UnderstandingTourDialog } from '../UnderstandingTourDialog';

vi.mock('../../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  Channel: class {
    onmessage = null;
    dispose = vi.fn();
  },
}));
vi.mock('../../store/store', async () => {
  const { createStore } = await import('solid-js/store');
  const [store] = createStore({ askCodeProvider: 'minimax', agentEnvFiles: {}, editorCommand: '' });
  return { store };
});
vi.mock('../../lib/understanding-request', () => ({ startUnderstandingRequest: vi.fn() }));
/** The map is its own editor; here it only has to hand an edit back. */
interface MapProps {
  document: MindMapDocument;
  onChange: (doc: MindMapDocument) => void;
}
const map = vi.hoisted(() => ({ props: undefined as MapProps | undefined }));
vi.mock('../../mindmap/MindMapEditor', () => ({
  MindMapEditor: (props: MapProps) => {
    // The test reads the props when it acts, so their reactivity is kept.
    // eslint-disable-next-line solid/reactivity
    map.props = props;
    // Like the editor's rename field: Solid-delegated, and Escape is its own.
    return (
      <div data-testid="mindmap">
        <input
          class="map-rename"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      </div>
    );
  },
}));

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const onClose = vi.fn();
  let controller: ReturnType<typeof createUnderstandingTour> | undefined;
  disposers.push(
    render(() => {
      controller = createUnderstandingTour();
      controller.startThinking({ worktreePath: '/repo', taskName: 'Task' });
      return (
        <UnderstandingTourDialog tour={controller} open onClose={onClose} worktreePath="/repo" />
      );
    }, host),
  );
  if (!controller) throw new Error('Controller was not created');
  return { tour: controller, onClose };
}

const field = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};
const title = () => field<HTMLInputElement>('.thinking-card-title');
const body = () => field<HTMLTextAreaElement>('.thinking-card-body');

function type(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  element.value = text;
  element.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const shownTitle = () => document.querySelector('.understanding-card-title')?.textContent;

describe('thinking tour', () => {
  it('opens ready to type a title, and Enter moves on to the text', async () => {
    const { tour } = mount();
    await flush();
    expect(document.activeElement).toBe(title());
    type(title(), 'Why sync breaks');
    press(title(), 'Enter');
    expect(document.activeElement).toBe(body());
    expect(tour.subject()).toBe('Why sync breaks');
    // Typing must keep the same field: a remounted card would take focus back to the title.
    const typedIn = body();
    type(typedIn, 'Two laptops edited offline.');
    await flush();
    expect(body()).toBe(typedIn);
    expect(document.activeElement).toBe(typedIn);
  });

  it('opens ready to type when started from a dialog already on the page', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const [open, setOpen] = createSignal(false);
    let controller: ReturnType<typeof createUnderstandingTour> | undefined;
    disposers.push(
      render(() => {
        controller = createUnderstandingTour();
        return (
          <UnderstandingTourDialog
            tour={controller}
            open={open()}
            onClose={() => {}}
            worktreePath="/repo"
          />
        );
      }, host),
    );
    controller?.startThinking({ worktreePath: '/repo', taskName: 'Task' });
    setOpen(true);
    await flush();
    expect(document.activeElement).toBe(title());
  });

  it('adds follow-ups and next cards from the keyboard', async () => {
    const { tour } = mount();
    await flush();
    type(title(), 'Root');
    press(title(), 'Tab');
    await flush();
    expect(tour.trail().map((node) => node.card.title)).toEqual(['Root', '']);
    expect(document.activeElement).toBe(title());
    expect(document.querySelector('.understanding-crumb')?.textContent).toContain(
      'Follow-up to Root · 1 of 1',
    );
    type(title(), 'Child');
    press(title(), 'Enter', { ctrlKey: true });
    await flush();
    type(title(), 'Second child');
    press(title(), 'Tab', { shiftKey: true });
    await flush();
    expect(tour.tree().map((node) => node.card.title)).toEqual(['Root', 'Second child']);
    expect(tour.tree()[0].children.map((node) => node.card.title)).toEqual(['Child']);
  });

  it('Escape ends typing without closing, and a blank card is dropped on leaving', async () => {
    const { tour, onClose } = mount();
    await flush();
    type(title(), 'Root');
    press(title(), 'Enter', { ctrlKey: true });
    await flush();
    expect(tour.tree()).toHaveLength(2);
    press(title(), 'Escape');
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('.thinking-card-title')).toBeNull();
    press(document.body, 'ArrowLeft');
    await flush();
    expect(tour.tree()).toHaveLength(1);
    expect(shownTitle()).toBe('Root');
    // Enter starts typing again on the card on screen.
    press(document.body, 'Enter');
    await flush();
    expect(document.activeElement).toBe(body());
  });

  it('starts typing on the card on screen with the key pressed', async () => {
    const { tour } = mount();
    await flush();
    type(title(), 'Root');
    press(title(), 'Escape');
    await flush();
    const event = press(document.body, 'b');
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(body());
    expect(tour.tree()[0].card.body).toBe('b');
    // A card with no title takes the key there.
    type(title(), '');
    press(body(), 'Escape');
    await flush();
    press(document.body, 'W', { shiftKey: true });
    await flush();
    expect(document.activeElement).toBe(title());
    expect(tour.tree()[0].card.title).toBe('W');
    expect(tour.tree()[0].card.body).toBe('b');
    // Shortcuts and Space on a control keep their meaning.
    press(title(), 'Escape');
    await flush();
    press(document.body, 'c', { ctrlKey: true });
    press(document.body, ' ');
    await flush();
    expect(document.querySelector('.thinking-card-title')).toBeNull();
  });

  it('moves between cards with Alt and the arrows while typing, adding one past the last', async () => {
    const { tour } = mount();
    await flush();
    type(title(), 'One');
    press(title(), 'ArrowRight', { altKey: true });
    await flush();
    expect(tour.tree().map((node) => node.card.title)).toEqual(['One', '']);
    expect(document.activeElement).toBe(title());
    type(title(), 'Two');
    press(title(), 'ArrowLeft', { altKey: true });
    await flush();
    expect(shownTitle() ?? title().value).toBe('One');
    // Typing carries on in the card moved to.
    expect(document.activeElement).toBe(body());
    press(body(), 'ArrowRight', { altKey: true });
    await flush();
    expect(title().value).toBe('Two');
    expect(tour.tree()).toHaveLength(2);
    // Down goes into the follow-ups, up back out to the card they follow.
    press(title(), 'Tab');
    await flush();
    type(title(), 'Under two');
    press(title(), 'ArrowUp', { altKey: true });
    await flush();
    expect(title().value).toBe('Two');
    press(body(), 'ArrowDown', { altKey: true });
    await flush();
    expect(title().value).toBe('Under two');
  });

  it('adds a follow-up with Alt and down on a card that has none', async () => {
    const { tour } = mount();
    await flush();
    type(title(), 'Root');
    press(title(), 'ArrowDown', { altKey: true });
    await flush();
    expect(tour.trail().map((node) => node.card.title)).toEqual(['Root', '']);
    expect(document.activeElement).toBe(title());
    // A blank card has nothing to follow up on.
    press(title(), 'ArrowDown', { altKey: true });
    await flush();
    expect(tour.trail()).toHaveLength(2);
  });

  it('moves with Alt and the arrows while reading, and adds a card after the last', async () => {
    const { tour } = mount();
    await flush();
    type(title(), 'One');
    press(title(), 'Escape');
    await flush();
    press(document.body, 'ArrowRight', { altKey: true });
    await flush();
    expect(tour.tree()).toHaveLength(2);
    expect(document.activeElement).toBe(title());
    press(title(), 'Escape');
    press(document.body, 'ArrowLeft', { altKey: true });
    await flush();
    // The blank card left behind is dropped.
    expect(tour.tree()).toHaveLength(1);
    expect(shownTitle()).toBe('One');
  });

  it('writes the card on screen with Alt+Enter while reading', async () => {
    vi.mocked(startUnderstandingRequest).mockReturnValueOnce({
      cancel: vi.fn(),
      result: new Promise(() => {}),
    });
    mount();
    await flush();
    type(title(), 'clocks');
    press(title(), 'Escape');
    await flush();
    press(document.body, 'Enter', { altKey: true });
    await flush();
    expect(startUnderstandingRequest).toHaveBeenCalledTimes(1);
  });

  it('shows which model writes the cards beside Write card', async () => {
    mount();
    await flush();
    const menu = document.querySelector('.thinking-hints [aria-haspopup="menu"]');
    expect(menu?.getAttribute('aria-label')).toMatch(/^Card model: /);
  });

  it('leaves keys pressed in the model menu to the menu', async () => {
    mount();
    await flush();
    type(title(), 'clocks');
    press(title(), 'Escape');
    await flush();
    field<HTMLButtonElement>('.thinking-hints [aria-haspopup="menu"]').click();
    await flush();
    const item = field<HTMLElement>('[role="menu"] [role^="menuitem"]');
    press(item, 'ArrowDown');
    press(item, 'a');
    await flush();
    expect(document.querySelector('.thinking-card-title')).toBeNull();
    expect(shownTitle()).toBe('clocks');
  });

  it('proposes the written card and takes it on Enter', async () => {
    let settle: (text: string) => void = () => {};
    vi.mocked(startUnderstandingRequest).mockReturnValueOnce({
      cancel: vi.fn(),
      result: new Promise((resolve) => (settle = (text) => resolve({ status: 'done', text }))),
    });
    const { tour } = mount();
    await flush();
    type(title(), 'clocks');
    type(body(), 'two clocks drift, retries resend');
    press(body(), 'Enter', { altKey: true });
    await flush();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Writing card');
    settle(
      JSON.stringify({
        cards: [
          { label: 'SYNC', title: 'Two clocks drift apart', points: ['a', 'b'], tone: 'neutral' },
          { label: 'RETRY', title: 'Retries resend stale data', points: ['c', 'd'], tone: 'risk' },
        ],
      }),
    );
    await flush();
    const frame = field('.thinking-proposal');
    expect(document.activeElement).toBe(frame);
    expect(frame.textContent).toContain('↳ Retries resend stale data');
    // The notes stay until the proposal is taken.
    expect(tour.tree()[0].card.title).toBe('clocks');
    press(frame, 'Enter');
    await flush();
    expect(tour.tree()[0].card.title).toBe('Two clocks drift apart');
    expect(tour.tree()[0].children[0].card.title).toBe('Retries resend stale data');
    expect(document.querySelector('.thinking-proposal')).toBeNull();
  });

  it('drops a card being written once the reader edits its notes again', async () => {
    const cancel = vi.fn();
    vi.mocked(startUnderstandingRequest).mockReturnValueOnce({
      cancel,
      result: new Promise(() => {}),
    });
    mount();
    await flush();
    type(title(), 'clocks');
    press(title(), 'Enter', { altKey: true });
    await flush();
    type(body(), 'typed while it was written');
    await flush();
    // A card written from older notes would replace this typing on Enter.
    expect(cancel).toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('switches to the mind map and back, taking its edits', async () => {
    const { tour } = mount();
    await flush();
    type(title(), 'Root');
    press(title(), 'm', { ctrlKey: true });
    await flush();
    expect(document.querySelector('[data-testid="mindmap"]')).not.toBeNull();
    const opened = map.props;
    if (!opened) throw new Error('The map did not open');
    const doc = opened.document;
    opened.onChange({
      ...doc,
      revision: doc.revision + 1,
      records: [
        ...doc.records,
        { id: 'idea', parent: doc.records[1].id, title: 'Idea', detail: '' },
      ],
    });
    // Ctrl+Shift+M is another shortcut's, not the map's.
    press(document.body, 'M', { ctrlKey: true, shiftKey: true });
    await flush();
    expect(document.querySelector('[data-testid="mindmap"]')).not.toBeNull();
    press(document.body, 'm', { ctrlKey: true });
    await flush();
    expect(document.querySelector('[data-testid="mindmap"]')).toBeNull();
    expect(tour.tree()[0].children.map((node) => node.card.title)).toEqual(['Idea']);
  });

  it('leaves Escape in the mind map to the map', async () => {
    const { onClose } = mount();
    await flush();
    type(title(), 'Root');
    press(title(), 'm', { ctrlKey: true });
    await flush();
    const rename = field<HTMLInputElement>('.map-rename');
    rename.focus();
    press(rename, 'Escape');
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves the keys to the tour on top when one opens over another', async () => {
    const { tour: below } = mount();
    await flush();
    type(title(), 'One');
    press(title(), 'ArrowRight', { altKey: true });
    await flush();
    type(title(), 'Two');
    press(title(), 'Escape');
    await flush();
    const shownBelow = below.currentId();
    // A second tour opens over the first, as the shortcut does over a task's tour.
    mount();
    await flush();
    press(document.querySelectorAll('.thinking-card-title')[0], 'Escape');
    await flush();
    press(document.body, 'ArrowLeft');
    await flush();
    expect(below.currentId()).toBe(shownBelow);
  });

  it('shows a failed write on the card it was for only', async () => {
    vi.mocked(startUnderstandingRequest).mockReturnValueOnce({
      cancel: vi.fn(),
      result: Promise.resolve({ status: 'failed', message: 'offline' }),
    });
    mount();
    await flush();
    type(title(), 'One');
    press(title(), 'Enter', { altKey: true });
    await flush();
    const failure = () => document.querySelector('[role="alert"]')?.textContent ?? '';
    expect(failure()).toContain('offline');
    press(title(), 'ArrowRight', { altKey: true });
    await flush();
    expect(failure()).toBe('');
  });
});
