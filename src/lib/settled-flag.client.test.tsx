import { createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettledFlag } from './settled-flag';

describe('createSettledFlag', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(initial: boolean) {
    return createRoot((dispose) => {
      const [source, setSource] = createSignal(initial);
      const settled = createSettledFlag(source, 60);
      return { settled, setSource, dispose };
    });
  }

  it('starts with the source value so a mounted active panel is not delayed', () => {
    const { settled, dispose } = setup(true);
    expect(settled()).toBe(true);
    dispose();
  });

  it('turns true only after the source stayed true for the delay', () => {
    const { settled, setSource, dispose } = setup(false);
    setSource(true);
    vi.advanceTimersByTime(59);
    expect(settled()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(settled()).toBe(true);
    dispose();
  });

  it('never turns true when the source is only briefly true', () => {
    const { settled, setSource, dispose } = setup(false);
    setSource(true);
    vi.advanceTimersByTime(30);
    setSource(false);
    vi.advanceTimersByTime(100);
    expect(settled()).toBe(false);
    dispose();
  });

  it('turns false immediately', () => {
    const { settled, setSource, dispose } = setup(true);
    setSource(false);
    expect(settled()).toBe(false);
    dispose();
  });
});
