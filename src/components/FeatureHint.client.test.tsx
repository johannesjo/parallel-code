import { Show, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined) }));

import { setStore, store } from '../store/core';
import { Dialog } from './Dialog';
import { FeatureHint } from './FeatureHint';

const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  // happy-dom lays nothing out: give every element a window-sized box, and
  // anchors a box of their own.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, window.innerWidth, window.innerHeight),
  );
  setStore('featureHintsEnabled', true);
  setStore('seenFeatureHints', []);
});

afterEach(() => {
  // Dispose first: a shown tip follows its anchor every frame.
  disposers.splice(0).forEach((dispose) => dispose());
  // A dismissal's cooldown must not hold back the next test's tips.
  vi.runAllTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function boxed(el: HTMLElement, top: number, left = 100): HTMLElement {
  el.getBoundingClientRect = () => new DOMRect(left, top, 200, 24);
  return el;
}
const anchorAt = (top: number) => boxed(document.createElement('div'), top);

/** The first frame measures the anchor; the tip shows 600ms after that. */
const settle = () => vi.advanceTimersByTime(650);

/** Renders, then waits out the delay before a tip may show. */
function mount(view: () => ReturnType<typeof FeatureHint>) {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(view, host));
  settle();
}

const notes = () => [...document.querySelectorAll<HTMLElement>('[role="note"]')];
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label);

describe('FeatureHint', () => {
  it('shows one tip at a time and the next one after a pause once it is dismissed', () => {
    const first = anchorAt(50);
    const second = anchorAt(300);
    mount(() => (
      <>
        <FeatureHint id="change-tour" when anchor={() => first} title="First">
          Body
        </FeatureHint>
        <FeatureHint id="finish-review" when anchor={() => second} title="Second">
          Body
        </FeatureHint>
      </>
    ));

    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toContain('First');

    button('Got it')?.click();
    expect(store.seenFeatureHints).toEqual(['change-tour']);
    expect(notes()).toHaveLength(0);

    vi.advanceTimersByTime(60_000);
    settle();
    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toContain('Second');
  });

  it('hands the slot to a waiting tip when the one on screen goes away', () => {
    const first = anchorAt(50);
    const second = anchorAt(300);
    const [showFirst, setShowFirst] = createSignal(true);
    mount(() => (
      <>
        <Show when={showFirst()}>
          <FeatureHint id="change-tour" when anchor={() => first} title="First">
            Body
          </FeatureHint>
        </Show>
        <FeatureHint id="finish-review" when anchor={() => second} title="Second">
          Body
        </FeatureHint>
      </>
    ));
    expect(notes()[0].textContent).toContain('First');

    setShowFirst(false);
    settle();
    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toContain('Second');
    expect(store.seenFeatureHints).toEqual([]);
  });

  it('waits until its feature has something to work on', () => {
    const anchor = anchorAt(50);
    const [ready, setReady] = createSignal(false);
    mount(() => (
      <FeatureHint id="change-tour" when={ready()} anchor={() => anchor} title="Tour">
        Body
      </FeatureHint>
    ));
    expect(notes()).toHaveLength(0);
    setReady(true);
    // A feature only passing through does not get a tip.
    vi.advanceTimersByTime(300);
    expect(notes()).toHaveLength(0);
    setReady(false);
    setReady(true);
    vi.advanceTimersByTime(300);
    expect(notes()).toHaveLength(0);
    vi.advanceTimersByTime(350);
    expect(notes()).toHaveLength(1);
  });

  it('shows nothing for an anchor scrolled out of its container', () => {
    const scroller = boxed(document.createElement('div'), 0);
    scroller.style.overflow = 'auto';
    const anchor = anchorAt(400);
    scroller.append(anchor);
    document.body.append(scroller);
    mount(() => (
      <FeatureHint id="change-tour" when anchor={() => anchor} title="Tour">
        Body
      </FeatureHint>
    ));
    expect(notes()).toHaveLength(0);

    boxed(anchor, 10);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(20);
    settle();
    expect(notes()).toHaveLength(1);
  });

  it('follows its anchor when it moves without a scroll', () => {
    const anchor = anchorAt(50);
    mount(() => (
      <FeatureHint id="change-tour" when anchor={() => anchor} title="Tour">
        Body
      </FeatureHint>
    ));
    const top = notes()[0].style.top;
    boxed(anchor, 120);
    vi.advanceTimersByTime(20);
    expect(notes()[0].style.top).not.toBe(top);
  });

  it('runs an action, counts it as seen, and keeps focus where it was', () => {
    const anchor = anchorAt(50);
    const run = vi.fn();
    mount(() => (
      <FeatureHint
        id="delegate-subtasks"
        when
        anchor={() => anchor}
        title="Delegate"
        actions={[{ label: 'Use example prompt', run }]}
      >
        Body
      </FeatureHint>
    ));
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button('Use example prompt')?.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);

    button('Use example prompt')?.click();
    expect(run).toHaveBeenCalledOnce();
    expect(store.seenFeatureHints).toEqual(['delegate-subtasks']);
    expect(notes()).toHaveLength(0);
  });

  it('steps aside for a dialog, and inside one lives in its panel', () => {
    const outside = anchorAt(50);
    let inside: HTMLElement | undefined;
    const [open, setOpen] = createSignal(false);
    mount(() => (
      <>
        <FeatureHint id="change-tour" when anchor={() => outside} title="Outside">
          Body
        </FeatureHint>
        <Dialog open={open()} onClose={() => setOpen(false)}>
          <div ref={(el) => (inside = boxed(el, 300))} />
          <FeatureHint id="finish-review" when anchor={() => inside} title="Inside">
            Body
          </FeatureHint>
        </Dialog>
      </>
    ));
    expect(notes().map((note) => note.textContent)).toEqual([expect.stringContaining('Outside')]);

    setOpen(true);
    expect(notes()).toHaveLength(0);
    settle();
    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toContain('Inside');
    expect(notes()[0].closest('.dialog-panel')).not.toBeNull();
  });

  it('hides under a dialog opened above its own, wherever that one sits in the page', () => {
    let inside: HTMLElement | undefined;
    const [over, setOver] = createSignal(false);
    mount(() => (
      <>
        {/* Created first, so its panel comes earlier in the page. */}
        <Dialog open={over()} onClose={() => setOver(false)}>
          Settings
        </Dialog>
        <Dialog open onClose={() => undefined}>
          <div ref={(el) => (inside = boxed(el, 300))} />
          <FeatureHint id="finish-review" when anchor={() => inside} title="Inside">
            Body
          </FeatureHint>
        </Dialog>
      </>
    ));
    expect(notes()).toHaveLength(1);

    setOver(true);
    expect(notes()).toHaveLength(0);
  });

  it('dismisses on Escape without closing the dialog around it', () => {
    let anchor: HTMLElement | undefined;
    const onClose = vi.fn();
    mount(() => (
      <Dialog open onClose={onClose}>
        <div ref={(el) => (anchor = boxed(el, 50))} />
        <FeatureHint id="finish-review" when anchor={() => anchor} title="Readiness">
          Body
        </FeatureHint>
      </Dialog>
    ));
    notes()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(notes()).toHaveLength(0);
    expect(store.seenFeatureHints).toEqual(['finish-review']);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows nothing while tips are turned off', () => {
    setStore('featureHintsEnabled', false);
    const anchor = anchorAt(50);
    mount(() => (
      <FeatureHint id="change-tour" when anchor={() => anchor} title="Tour">
        Body
      </FeatureHint>
    ));
    expect(notes()).toHaveLength(0);
  });
});
