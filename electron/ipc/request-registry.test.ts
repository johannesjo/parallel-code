import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AskCodeSession,
  RequestRegistry,
  assertCanStart,
  assertPromptWithinLimit,
} from './request-registry.js';
import { CHANGE_TOUR_TIMEOUT_MS, CHANGE_TOUR_PROMPT_LIMIT } from '../shared/change-tour-limits.js';

describe('RequestRegistry', () => {
  it('accepts the full tour prompt budget', () => {
    const prompt = 'x'.repeat(CHANGE_TOUR_PROMPT_LIMIT);
    expect(() => assertPromptWithinLimit(prompt, CHANGE_TOUR_PROMPT_LIMIT)).not.toThrow();
    expect(() => assertPromptWithinLimit(prompt)).toThrow(/Prompt too long/);
  });
  it('gives tours five minutes while inline questions still time out after two', () => {
    vi.useFakeTimers();
    const registry = new RequestRegistry<string>({ maxConcurrent: 5, timeoutMs: 120_000 });
    const questionSend = vi.fn();
    const tourSend = vi.fn();
    const cancelTour = vi.fn();
    AskCodeSession.start(registry, 'question', 'question', questionSend);
    AskCodeSession.start(registry, 'tour', 'tour', tourSend, cancelTour, CHANGE_TOUR_TIMEOUT_MS);
    vi.advanceTimersByTime(120_000);
    expect(questionSend).toHaveBeenCalledWith({
      type: 'error',
      text: 'Request timed out after 2 minutes.',
    });
    expect(tourSend).not.toHaveBeenCalled();
    expect(registry.has('tour')).toBe(true);
    vi.advanceTimersByTime(CHANGE_TOUR_TIMEOUT_MS - 120_000);
    expect(tourSend).toHaveBeenCalledWith({
      type: 'error',
      text: 'Request timed out after 5 minutes.',
    });
    expect(cancelTour).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enforces the concurrency limit', () => {
    const registry = new RequestRegistry<string>({ maxConcurrent: 1, timeoutMs: 1000 });

    registry.start('a', 'first', vi.fn());

    expect(() => registry.start('b', 'second', vi.fn())).toThrow(
      'Too many concurrent ask-about-code requests',
    );
  });

  it('replaces an existing request with the same id', () => {
    const registry = new RequestRegistry<{ cancel: () => void }>({
      maxConcurrent: 5,
      timeoutMs: 1000,
    });
    const firstCancel = vi.fn();

    registry.start('same', { cancel: firstCancel }, vi.fn(), (request) => request.cancel());
    registry.start('same', { cancel: vi.fn() }, vi.fn());

    expect(firstCancel).toHaveBeenCalledOnce();
    expect(registry.has('same')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('ignores cleanup from a replaced request', () => {
    const registry = new RequestRegistry<string>({ maxConcurrent: 1, timeoutMs: 1000 });

    const first = registry.start('same', 'first', vi.fn());
    const second = registry.start('same', 'second', vi.fn());

    expect(registry.finish(first)).toBeUndefined();
    expect(registry.has('same')).toBe(true);
    expect(registry.isCurrent(second)).toBe(true);
  });

  it('ignores a stale timeout callback after the request id is replaced', () => {
    vi.useFakeTimers();
    const registry = new RequestRegistry<{ cancel: () => void }>({
      maxConcurrent: 1,
      timeoutMs: 1000,
    });
    const firstTimeout = vi.fn();
    const firstCancel = vi.fn();
    const secondTimeout = vi.fn();
    const secondCancel = vi.fn();

    registry.start('same', { cancel: firstCancel }, firstTimeout, (request) => request.cancel());
    registry.start('same', { cancel: secondCancel }, secondTimeout, (request) => request.cancel());
    vi.advanceTimersByTime(1000);

    expect(firstTimeout).not.toHaveBeenCalled();
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondTimeout).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(registry.has('same')).toBe(false);
  });

  describe('canStart', () => {
    it('allows starting when below the concurrency limit', () => {
      const registry = new RequestRegistry<string>({ maxConcurrent: 2, timeoutMs: 1000 });

      expect(registry.canStart('a')).toBe(true);
      registry.start('a', 'first', vi.fn());

      expect(registry.canStart('b')).toBe(true);
    });

    it('blocks a new id once the registry is at capacity', () => {
      const registry = new RequestRegistry<string>({ maxConcurrent: 1, timeoutMs: 1000 });

      registry.start('a', 'first', vi.fn());

      expect(registry.canStart('b')).toBe(false);
    });

    it('allows restarting the same id even when the registry is at capacity', () => {
      const registry = new RequestRegistry<string>({ maxConcurrent: 1, timeoutMs: 1000 });

      registry.start('a', 'first', vi.fn());

      expect(registry.canStart('a')).toBe(true);
      expect(() => registry.start('a', 'second', vi.fn())).not.toThrow();
      expect(registry.size).toBe(1);
    });
  });

  it('cleans up and runs timeout handling once', () => {
    vi.useFakeTimers();
    const registry = new RequestRegistry<{ cancel: () => void }>({
      maxConcurrent: 5,
      timeoutMs: 1000,
    });
    const cancel = vi.fn();
    const onTimeout = vi.fn();

    registry.start('req', { cancel }, onTimeout, (request) => request.cancel());
    vi.advanceTimersByTime(1000);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(registry.has('req')).toBe(false);
  });
});

describe('assertPromptWithinLimit', () => {
  it('does not throw for a prompt within the limit', () => {
    expect(() => assertPromptWithinLimit('short', 10)).not.toThrow();
  });

  it('throws once the prompt exceeds the limit', () => {
    expect(() => assertPromptWithinLimit('x'.repeat(11), 10)).toThrow(/Prompt too long/);
  });
});

describe('assertCanStart', () => {
  it('throws the shared concurrency message once the registry is full', () => {
    const registry = new RequestRegistry<string>({ maxConcurrent: 1, timeoutMs: 1000 });
    registry.start('a', 'first', vi.fn());

    expect(() => assertCanStart(registry, 'b')).toThrow(
      'Too many concurrent ask-about-code requests',
    );
  });

  it('allows a restart of the same id even at capacity', () => {
    const registry = new RequestRegistry<string>({ maxConcurrent: 1, timeoutMs: 1000 });
    registry.start('a', 'first', vi.fn());

    expect(() => assertCanStart(registry, 'a')).not.toThrow();
  });
});

describe('AskCodeSession', () => {
  it('reports the timeout message exactly once even if completed twice', () => {
    const registry = new RequestRegistry<string>({ maxConcurrent: 5, timeoutMs: 1000 });
    const handle = registry.start('req', 'value', vi.fn());
    const session = new AskCodeSession(registry, handle);
    const send = vi.fn();

    expect(session.complete()).toBe(true);
    session.onTimeout(send);

    expect(send).not.toHaveBeenCalled();
  });

  it('sends the timeout error and done messages when not yet completed', () => {
    const registry = new RequestRegistry<string>({ maxConcurrent: 5, timeoutMs: 1000 });
    const handle = registry.start('req', 'value', vi.fn());
    const session = new AskCodeSession(registry, handle);
    const send = vi.fn();

    session.onTimeout(send);

    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'error',
      text: 'Request timed out after 2 minutes.',
    });
    expect(send).toHaveBeenNthCalledWith(2, { type: 'done', exitCode: 1 });
    expect(session.complete()).toBe(false);
  });

  it('cleanup releases the registry slot', () => {
    const registry = new RequestRegistry<string>({ maxConcurrent: 1, timeoutMs: 1000 });
    const handle = registry.start('req', 'value', vi.fn());
    const session = new AskCodeSession(registry, handle);

    session.cleanup();

    expect(registry.has('req')).toBe(false);
  });
});
