import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HoverHint } from './HoverHint';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Opens a hint `height` px tall on a control 20px high whose top edge is at `top`, in an 800px window. */
function openHint(top: number, height: number): HTMLElement {
  vi.stubGlobal('innerHeight', 800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'tooltip' ? height : 0;
  });
  dispose = render(
    () => (
      <HoverHint hint={() => <p>Why</p>}>
        {(describedBy) => (
          <button type="button" aria-describedby={describedBy()}>
            Score
          </button>
        )}
      </HoverHint>
    ),
    document.body,
  );
  const anchor = document.body.querySelector<HTMLElement>('.tour-hint-anchor');
  if (!anchor) throw new Error('No anchor');
  anchor.getBoundingClientRect = () =>
    ({ top, bottom: top + 20, left: 100, right: 200, width: 100, height: 20 }) as DOMRect;
  anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  const hint = document.body.querySelector<HTMLElement>('[role="tooltip"]');
  if (!hint) throw new Error('No hint');
  return hint;
}

describe('HoverHint placement', () => {
  it('hangs under its control while the hint fits there', () => {
    // Control ends at 520; 2px gap.
    expect(openHint(500, 150).style.top).toBe('522px');
  });

  it('sits above its control when a tall hint would run past the foot of the window', () => {
    // 800 − 520 leaves 280 below, less the gap and the 12px edge: 330 does not fit. Above: 500 − 2 − 330.
    expect(openHint(500, 330).style.top).toBe('168px');
  });

  it('rests on its control when it sits above, however short it is', () => {
    // Control starts at 700, too low for 150px below; the hint ends 2px above it: 700 − 2 − 150.
    expect(openHint(700, 150).style.top).toBe('548px');
  });
});
