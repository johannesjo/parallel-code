import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});

const panels = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const focusedLabel = () => document.activeElement?.getAttribute('aria-label') ?? null;
function pressTab() {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
}

/** A lower dialog with an upper one stacked on top of it, as a tour is over the plan viewer. */
function mountStacked() {
  const host = document.createElement('div');
  document.body.append(host);
  const [upperOpen, setUpperOpen] = createSignal(true);
  disposers.push(
    render(
      () => (
        <>
          <Dialog open={true} onClose={vi.fn()}>
            <button aria-label="lower one" />
            <button aria-label="lower two" />
          </Dialog>
          <Dialog open={upperOpen()} onClose={vi.fn()}>
            <button aria-label="upper one" />
            <button aria-label="upper two" />
          </Dialog>
        </>
      ),
      host,
    ),
  );
  return { setUpperOpen };
}

describe('Dialog focus trap with stacked dialogs', () => {
  it('cycles Tab inside the topmost dialog only', () => {
    mountStacked();
    const lower = panels()[0];

    pressTab();
    expect(focusedLabel()).toBe('upper one');
    // Before the underlying trap was suspended, this reset to the first control.
    pressTab();
    expect(focusedLabel()).toBe('upper two');
    pressTab();
    expect(focusedLabel()).toBe('upper one');
    expect(lower.contains(document.activeElement)).toBe(false);
  });

  it('hands the trap back to the dialog below when the top one closes', () => {
    const { setUpperOpen } = mountStacked();
    setUpperOpen(false);
    const lower = panels()[0];

    pressTab();
    expect(focusedLabel()).toBe('lower one');
    pressTab();
    expect(focusedLabel()).toBe('lower two');
    expect(lower.contains(document.activeElement)).toBe(true);
  });
});

describe('Dialog backdrop', () => {
  function mountOne() {
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <Dialog open={true} onClose={onClose}>
            <input aria-label="field" />
          </Dialog>
        ),
        host,
      ),
    );
    const overlay = document.querySelector<HTMLElement>('.dialog-overlay');
    if (!overlay) throw new Error('No overlay');
    return { onClose, overlay };
  }
  const press = (el: Element | null, type: string) =>
    el?.dispatchEvent(new MouseEvent(type, { bubbles: true }));

  it('closes on a click that starts and ends on the backdrop', () => {
    const { onClose, overlay } = mountOne();

    press(overlay, 'mousedown');
    press(overlay, 'mouseup');
    press(overlay, 'click');

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open when a press on the backdrop is released in the panel', () => {
    const { onClose, overlay } = mountOne();

    press(overlay, 'mousedown');
    press(document.querySelector('[aria-label="field"]'), 'mouseup');
    press(overlay, 'click');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when a text selection is dragged out onto the backdrop', () => {
    const { onClose, overlay } = mountOne();

    // The browser sends the click to the common ancestor: the backdrop.
    press(document.querySelector('[aria-label="field"]'), 'mousedown');
    press(overlay, 'mouseup');
    press(overlay, 'click');

    expect(onClose).not.toHaveBeenCalled();
  });
});
