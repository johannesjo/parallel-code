import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersMotion } from './reducedMotion';

describe('prefersMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows animation when reduced motion is not requested', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal('window', { matchMedia });

    expect(prefersMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('disables animation when reduced motion is requested', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('window', { matchMedia });

    expect(prefersMotion()).toBe(false);
  });

  it('allows animation when matchMedia is unavailable', () => {
    vi.stubGlobal('window', {});

    expect(prefersMotion()).toBe(true);
  });
});
