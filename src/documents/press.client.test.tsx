import { describe, expect, it, vi } from 'vitest';
import { afterPress } from './press';

describe('afterPress', () => {
  it('waits for the release of a held button', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    afterPress(fn);
    expect(fn).not.toHaveBeenCalled();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('runs once the window loses the press, not again on a later click', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    afterPress(fn);
    window.dispatchEvent(new Event('blur'));
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledOnce();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('knows a drag of text or a link has let go, as it ends without a release', () => {
    const fn = vi.fn();
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    document.dispatchEvent(new Event('dragend'));
    afterPress(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('drops the wait when the press turns into a drag, which ends without a release', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    afterPress(fn);
    document.dispatchEvent(new Event('dragend'));
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
