import { createMemo, createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardTaskState } from './board/task-state';
import { WORKING_HOLD_MS, holdWorking } from './task-board-hold';

let nextId = 0;

function track(initial: CardTaskState) {
  const taskId = `task-${nextId++}`;
  return createRoot((dispose) => {
    const [raw, setRaw] = createSignal(initial);
    const shown = createMemo(() => holdWorking(taskId, raw()));
    return { shown, setRaw, dispose };
  });
}

describe('holdWorking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a task that just stopped working in Working until the hold runs out', () => {
    const t = track('active');
    t.setRaw('idle');
    expect(t.shown()).toBe('active');
    vi.advanceTimersByTime(WORKING_HOLD_MS - 1);
    expect(t.shown()).toBe('active');
    vi.advanceTimersByTime(1);
    expect(t.shown()).toBe('idle');
    t.dispose();
  });

  it('times the hold from when work stopped, not from when it started', () => {
    const t = track('active');
    vi.advanceTimersByTime(60_000);
    t.setRaw('ready');
    expect(t.shown()).toBe('active');
    t.dispose();
  });

  it('never leaves Working when work resumes within the hold', () => {
    const t = track('active');
    t.setRaw('idle');
    vi.advanceTimersByTime(WORKING_HOLD_MS - 1_000);
    t.setRaw('active');
    vi.advanceTimersByTime(WORKING_HOLD_MS - 1_000);
    t.setRaw('idle');
    vi.advanceTimersByTime(WORKING_HOLD_MS - 1_000);
    expect(t.shown()).toBe('active');
    t.dispose();
  });

  it('passes urgent states through at once', () => {
    const t = track('active');
    t.setRaw('needs_input');
    expect(t.shown()).toBe('needs_input');
    t.setRaw('idle');
    expect(t.shown()).toBe('idle');
    t.dispose();
  });

  it('leaves tasks that were never working alone', () => {
    const t = track('idle');
    expect(t.shown()).toBe('idle');
    t.dispose();
  });
});
