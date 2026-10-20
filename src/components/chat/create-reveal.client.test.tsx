import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReveal } from './create-reveal';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
let setInput: (next: { text: string; running: boolean }) => void;
let motion: MediaQueryList;
let now: number;
let frameId: number;
const frames = new Map<number, FrameRequestCallback>();
const act = async (action: () => unknown) => {
  await action();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
async function update(text: string, running: boolean) {
  if (dispose) return act(() => setInput({ text, running }));
  const [input, set] = createSignal({ text, running });
  setInput = set;
  dispose = render(() => {
    const shown = createReveal(
      () => input().text,
      () => input().running,
    );
    return <span>{shown()}</span>;
  }, container);
  await act(() => undefined);
}
beforeEach(() => {
  now = 0;
  frameId = 0;
  frames.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  motion = matchMedia('(prefers-reduced-motion: reduce)');
  vi.stubGlobal('matchMedia', () => motion);
  container = document.createElement('div');
  dispose = undefined;
});
afterEach(() => {
  dispose?.();
  expect(frames.size).toBe(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('smooth reveal', () => {
  it('reveals appended text without splitting emoji and flushes on completion', async () => {
    await update('Start ', true);
    const text = 'Start ' + '🙂'.repeat(100);
    await update(text, true);
    expect(container.textContent).toBe('Start ');
    await act(() => {
      now = 50;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(now));
    });
    const partial = container.textContent ?? '';
    expect(partial.length).toBeGreaterThan('Start '.length);
    expect(partial.length).toBeLessThan(text.length);
    expect(partial).toMatch(/^Start (🙂)+$/u);
    await update(text, false);
    expect(container.textContent).toBe(text);
  });
  it('shows history immediately and honors reduced motion during a response', async () => {
    await update('History', false);
    expect(container.textContent).toBe('History');
    await update('New response', true);
    expect(container.textContent).toBe('New response');
    Object.defineProperty(motion, 'matches', { value: true, configurable: true });
    await update('New response plus a large update', true);
    expect(container.textContent).toBe('New response plus a large update');
  });
});
