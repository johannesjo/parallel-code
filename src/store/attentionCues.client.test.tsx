import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskAttentionState } from './taskStatus';

type AttentionMap = Record<string, TaskAttentionState>;
interface Harness {
  store: {
    taskOrder: string[];
    collapsedTaskOrder: string[];
    tasks: Record<string, unknown>;
    agents: Record<string, unknown>;
    completionSoundEnabled: boolean;
  };
  setStore: (...args: unknown[]) => void;
  attention: () => AttentionMap;
  setAttention: (next: AttentionMap | ((prev: AttentionMap) => AttentionMap)) => void;
  chime: ReturnType<typeof vi.fn>;
}

// Solid primitives must come from the same module instance the code under test
// imports, so they are created inside the mock factories rather than hoisted.
const harness = vi.hoisted(() => ({ chime: vi.fn(() => true) }) as Harness);

vi.mock('./core', async () => {
  const { createStore } = await import('solid-js/store');
  const [store, setStore] = createStore<Harness['store']>({
    taskOrder: [],
    collapsedTaskOrder: [],
    tasks: {},
    agents: {},
    completionSoundEnabled: true,
  });
  harness.store = store;
  harness.setStore = setStore as Harness['setStore'];
  return { store, setStore };
});
vi.mock('./taskStatus', async () => {
  const { createSignal } = await import('solid-js');
  const [attention, setAttention] = createSignal<AttentionMap>({});
  harness.attention = attention;
  harness.setAttention = setAttention;
  return { getTaskAttentionState: (id: string) => attention()[id] ?? 'idle' };
});
vi.mock('./desktopNotifications', () => ({
  shouldShowDesktopNotificationForTask: () => true,
}));
vi.mock('../lib/completion-chime', () => ({ playCompletionChime: harness.chime }));

import { clearTaskGlow, startAttentionCueWatcher, taskGlow } from './attentionCues';

function setState(id: string, state: TaskAttentionState): void {
  harness.setAttention((prev) => ({ ...prev, [id]: state }));
}

describe('startAttentionCueWatcher', () => {
  let stop: () => void;

  beforeEach(() => {
    harness.setStore({
      taskOrder: ['a', 'b'],
      collapsedTaskOrder: [],
      completionSoundEnabled: true,
    });
    harness.setAttention({ a: 'active', b: 'active' });
    harness.chime.mockClear();
    stop = startAttentionCueWatcher();
  });

  afterEach(() => {
    stop();
    clearTaskGlow('a');
    clearTaskGlow('b');
  });

  it('does not cue the states present at startup', () => {
    expect(taskGlow('a')).toBeUndefined();
    expect(harness.chime).not.toHaveBeenCalled();
  });

  it('glows and chimes when a task turns ready', () => {
    setState('a', 'ready');
    expect(taskGlow('a')?.type).toBe('ready');
    expect(harness.chime).toHaveBeenCalledWith('ready');
  });

  it('plays one chime for a burst and picks the most urgent', () => {
    harness.setAttention({ a: 'ready', b: 'error' });
    expect(taskGlow('a')?.type).toBe('ready');
    expect(taskGlow('b')?.type).toBe('error');
    expect(harness.chime).toHaveBeenCalledTimes(1);
    expect(harness.chime).toHaveBeenCalledWith('error');
  });

  it('keeps the glow but stays silent when the chime is disabled', () => {
    harness.setStore('completionSoundEnabled', false);
    setState('b', 'needs_input');
    expect(taskGlow('b')?.type).toBe('needs_input');
    expect(harness.chime).not.toHaveBeenCalled();
  });

  it('forgets a task that was removed', () => {
    setState('a', 'ready');
    harness.setStore('taskOrder', ['b']);
    expect(taskGlow('a')).toBeUndefined();
  });

  it('stops reacting once cleaned up', () => {
    stop();
    setState('a', 'ready');
    expect(taskGlow('a')).toBeUndefined();
    expect(harness.chime).not.toHaveBeenCalled();
  });
});
