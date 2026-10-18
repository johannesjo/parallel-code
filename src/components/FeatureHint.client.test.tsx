import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined) }));

import { setStore, store } from '../store/core';
import { Dialog } from './Dialog';
import { FeatureHint } from './FeatureHint';

const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  setStore('featureHintsEnabled', true);
  setStore('seenFeatureHints', []);
});

afterEach(() => {
  // A dismissal's cooldown must not hold back the next test's tips.
  vi.runAllTimers();
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** happy-dom lays nothing out, so give the anchor an on-screen box. */
function anchorAt(top: number): HTMLDivElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => new DOMRect(100, top, 200, 24);
  return el;
}

function mount(view: () => ReturnType<typeof FeatureHint>) {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(view, host));
}

const notes = () => [...document.querySelectorAll('[role="note"]')];
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
    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toContain('Second');
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
    expect(notes()).toHaveLength(1);
  });

  it('runs an action and counts it as seen', () => {
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
    button('Use example prompt')?.click();
    expect(run).toHaveBeenCalledOnce();
    expect(store.seenFeatureHints).toEqual(['delegate-subtasks']);
    expect(notes()).toHaveLength(0);
  });

  it('steps aside for a dialog, and inside one lives in its panel', () => {
    const outside = anchorAt(50);
    let inside: HTMLDivElement | undefined;
    const [open, setOpen] = createSignal(false);
    mount(() => (
      <>
        <FeatureHint id="change-tour" when anchor={() => outside} title="Outside">
          Body
        </FeatureHint>
        <Dialog open={open()} onClose={() => setOpen(false)}>
          <div
            ref={(el) => {
              el.getBoundingClientRect = () => new DOMRect(100, 300, 200, 24);
              inside = el;
            }}
          />
          <FeatureHint id="finish-review" when anchor={() => inside} title="Inside">
            Body
          </FeatureHint>
        </Dialog>
      </>
    ));
    expect(notes().map((note) => note.textContent)).toEqual([expect.stringContaining('Outside')]);

    setOpen(true);
    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toContain('Inside');
    expect(notes()[0].closest('.dialog-panel')).not.toBeNull();
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
