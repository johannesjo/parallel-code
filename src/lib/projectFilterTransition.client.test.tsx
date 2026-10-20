import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { createProjectFilterTransition } from './projectFilterTransition';
import { shouldAnimateTaskAppearance } from './reducedMotion';

vi.mock('./reducedMotion', () => ({ shouldAnimateTaskAppearance: vi.fn(() => true) }));
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

function fixture() {
  const [filter, setFilter] = createSignal<string | null>(null);
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
  const host = document.createElement('div');
  host.animate = animate;
  document.body.append(host);
  dispose = render(() => {
    createProjectFilterTransition(filter, () => host);
    return null;
  }, host);
  return { setFilter, animate, cancel };
}

it('does not animate initial rendering and cancels an old fade when switching again', async () => {
  vi.mocked(shouldAnimateTaskAppearance).mockReturnValue(true);
  const { setFilter, animate, cancel } = fixture();
  expect(animate).not.toHaveBeenCalled();
  setFilter('one');
  await vi.waitFor(() => expect(animate).toHaveBeenCalledOnce());
  setFilter('two');
  expect(cancel).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
  dispose?.();
  dispose = undefined;
  expect(cancel).toHaveBeenCalledTimes(2);
});

it('honors reduced motion', async () => {
  vi.mocked(shouldAnimateTaskAppearance).mockReturnValue(false);
  const { setFilter, animate } = fixture();
  setFilter('one');
  await new Promise(requestAnimationFrame);
  expect(animate).not.toHaveBeenCalled();
});
