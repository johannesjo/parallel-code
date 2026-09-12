import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentViewer } from './DocumentViewer';
import { createRenderedBlocks } from './use-blocks';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/ipc', () => ({ invoke }));

const disposers: Array<() => void> = [];

/** Every block is this tall in the fake layout, unless `heights` says otherwise. */
const BLOCK_HEIGHT = 100;
const heights = new Map<number, number>();

/** The observers currently watching the prose, newest last. */
let watchers: Array<{ callback: () => void; target: Element }> = [];

class TestResizeObserver {
  #callback: () => void;
  constructor(callback: () => void) {
    this.#callback = callback;
  }
  observe(target: Element): void {
    watchers.push({ callback: this.#callback, target });
  }
  unobserve(): void {
    this.disconnect();
  }
  disconnect(): void {
    watchers = watchers.filter((w) => w.callback !== this.#callback);
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  heights.clear();
  watchers = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The prose settled into a new height: what a late mermaid render looks like. */
function settle(): void {
  for (const watcher of [...watchers]) watcher.callback();
}

function topFor(index: number): number {
  let top = 0;
  for (let i = 0; i < index; i++) top += heights.get(i) ?? BLOCK_HEIGHT;
  return top;
}

/**
 * happy-dom lays nothing out, so blocks are given the geometry they would
 * have in the app: stacked, of `heights`, moving with the scroller.
 */
function fakeLayout(scroller: HTMLElement): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === scroller) return { top: 0, bottom: 300 } as DOMRect;
    const raw = (this as HTMLElement).dataset?.blockIndex;
    if (raw === undefined) return { top: 0, bottom: 0 } as DOMRect;
    const index = Number(raw);
    const top = topFor(index) - scroller.scrollTop;
    return { top, bottom: top + (heights.get(index) ?? BLOCK_HEIGHT) } as DOMRect;
  });
}

function mount(initial: string): {
  scroller: HTMLElement;
  edit: (source: string) => void;
} {
  const [source, edit] = createSignal(initial);
  const host = document.createElement('div');
  document.body.append(host);
  let scroller: HTMLDivElement | undefined;
  disposers.push(
    render(() => {
      const blocks = createRenderedBlocks(source, () => scroller);
      return (
        <div ref={scroller}>
          <DocumentViewer blocks={blocks.blocks()} page={blocks.page()} renderKey="t" />
        </div>
      );
    }, host),
  );
  if (!scroller) throw new Error('Scroller did not render');
  return { scroller, edit };
}

async function blockCount(scroller: HTMLElement, count: number): Promise<void> {
  await vi.waitFor(() =>
    expect(scroller.querySelectorAll('[data-block-index]')).toHaveLength(count),
  );
}

const MARKDOWN = '# Doc\n\nAlpha.\n\nBravo.\n\nCharlie.\n';
const MARKDOWN_EDITED = '# Doc\n\nInserted.\n\nAlpha.\n\nBravo.\n\nCharlie.\n';
const PAGE =
  '<!doctype html><html><head><style>p{margin:0}</style></head>' +
  '<body><h1>Doc</h1><p>Alpha.</p><p>Bravo.</p><p>Charlie.</p></body></html>';
const PAGE_EDITED = PAGE.replace('<p>Alpha.</p>', '<p>Inserted.</p><p>Alpha.</p>');

it('holds the passage being read when markdown changes above it', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  // Bravo, the third block, sits at the top of the viewport.
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);

  // Bravo is the fourth block now, so the prose scrolled with it: what the
  // reader was looking at is still under the same pixel.
  expect(scroller.scrollTop).toBe(3 * BLOCK_HEIGHT);
});

it('holds the passage being read when an HTML page changes above it', async () => {
  const { scroller, edit } = mount(PAGE);
  // The page's heading loses its element to happy-dom's sanitize pass, so
  // three of its four blocks carry a marked element here.
  await blockCount(scroller, 3);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(PAGE_EDITED);
  await blockCount(scroller, 4);

  expect(scroller.scrollTop).toBe(3 * BLOCK_HEIGHT);
});

it('stays where it is when the edit lands below the reading position', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = BLOCK_HEIGHT;

  edit(`${MARKDOWN}\nDelta.\n`);
  await blockCount(scroller, 5);

  expect(scroller.scrollTop).toBe(BLOCK_HEIGHT);
});

it('leaves a document read from the top at the top', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);

  expect(scroller.scrollTop).toBe(0);
});

it('keeps its grip while a diagram above the reader is still being drawn', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);
  expect(scroller.scrollTop).toBe(3 * BLOCK_HEIGHT);

  // The inserted block finishes rendering 200px taller than it landed.
  heights.set(1, BLOCK_HEIGHT + 200);
  settle();

  expect(scroller.scrollTop).toBe(3 * BLOCK_HEIGHT + 200);
});

it('lets go of the passage as soon as the reader scrolls', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);

  scroller.scrollTop = 50;
  heights.set(1, BLOCK_HEIGHT + 200);
  settle();

  expect(scroller.scrollTop).toBe(50);
  // And the grip is gone for good, not just for this one settling.
  settle();
  expect(scroller.scrollTop).toBe(50);
});

it('watches the prose, not the scroll container that keeps its own size', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);

  expect(watchers).toHaveLength(1);
  expect(watchers[0].target).toBe(scroller.firstElementChild);
});

it('holds a document once, however many edits land', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);
  edit(`${MARKDOWN_EDITED}\nDelta.\n`);
  await blockCount(scroller, 6);

  // The earlier hold let go; two of them would pull against each other.
  expect(watchers).toHaveLength(1);
});

it('takes no grip on a document read from the top', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);

  expect(watchers).toHaveLength(0);
});

it('is still holding when a diagram arrives a second and a half late', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);
  const settledAt = Date.now();

  // One arrival, late: a mermaid render behind a cold dynamic import.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(settledAt + 1500);
  heights.set(1, BLOCK_HEIGHT + 200);
  settle();

  expect(scroller.scrollTop).toBe(3 * BLOCK_HEIGHT + 200);
});

it('lets go once the document has had its time to settle', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);
  const settledAt = Date.now();

  // Nothing resized for long enough that a late render is no longer late.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(settledAt + 6000);
  heights.set(1, BLOCK_HEIGHT + 200);
  settle();

  expect(scroller.scrollTop).toBe(3 * BLOCK_HEIGHT);
  expect(watchers).toHaveLength(0);
});

it('releases the grip when the document it held is closed', async () => {
  const [source, edit] = createSignal<string | null>(MARKDOWN);
  const host = document.createElement('div');
  document.body.append(host);
  let scroller: HTMLDivElement | undefined;
  disposers.push(
    render(() => {
      const blocks = createRenderedBlocks(source, () => scroller);
      return (
        <div ref={scroller}>
          <DocumentViewer blocks={blocks.blocks()} page={blocks.page()} renderKey="t" />
        </div>
      );
    }, host),
  );
  if (!scroller) throw new Error('Scroller did not render');
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;
  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);
  expect(watchers).toHaveLength(1);

  // Opening another document clears the snapshot first; nothing of the old
  // one may reach back and scroll the new one.
  edit(null);
  await blockCount(scroller, 0);

  expect(watchers).toHaveLength(0);
});

it('does not mistake a fraction of a pixel for the reader', async () => {
  const { scroller, edit } = mount(MARKDOWN);
  await blockCount(scroller, 4);
  fakeLayout(scroller);
  scroller.scrollTop = 2 * BLOCK_HEIGHT;

  edit(MARKDOWN_EDITED);
  await blockCount(scroller, 5);

  // Native scroll anchoring nudges the container as the late content grows.
  scroller.scrollTop = 3 * BLOCK_HEIGHT + 1;
  heights.set(1, BLOCK_HEIGHT + 200);
  settle();

  expect(scroller.scrollTop).toBe(3 * BLOCK_HEIGHT + 200);
  expect(watchers).toHaveLength(1);
});
