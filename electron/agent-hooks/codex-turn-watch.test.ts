import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexTurnWatch } from './codex-turn-watch.js';
import type { AgentHookEventPayload } from './status.js';

// Rows as Codex CLI 0.167.0 drew them, mid-turn and after a failed request.
const RUNNING = '› go\n\n• Working (6s • esc to interrupt)\n\n› Ask Codex to do anything';
const FAILED = '› go\n\n■ {"error":{"message":"mock failure"}}\n\n› Ask Codex to do anything';

const identity = { agentId: 'agent-1', taskId: 'task-1', launchId: 'launch-1' };
const working: AgentHookEventPayload = {
  ...identity,
  state: 'working',
  event: 'UserPromptSubmit',
  at: 1,
};

function setup(screens: (string | null)[]) {
  const failed: AgentHookEventPayload[] = [];
  const screenText = vi.fn(() => (screens.length > 1 ? screens.shift() : screens[0]) ?? null);
  const watch = createCodexTurnWatch({
    screenText,
    onFailed: (event) => failed.push(event),
    checkMs: 1_000,
    now: () => 99,
  });
  return { watch, failed, screenText };
}

describe('createCodexTurnWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ends a working turn as failed once the screen shows the empty input box twice', () => {
    const { watch, failed } = setup([FAILED]);
    watch.note(working);
    vi.advanceTimersByTime(1_000);
    expect(failed).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(failed).toEqual([
      {
        ...identity,
        state: 'done',
        event: 'StopFailure',
        detail: 'Stopped without a reply',
        at: 99,
      },
    ]);
    vi.advanceTimersByTime(5_000);
    expect(failed).toHaveLength(1);
  });

  it('leaves a turn alone while its screen shows it running', () => {
    const { watch, failed } = setup([RUNNING]);
    watch.note(working);
    vi.advanceTimersByTime(10_000);
    expect(failed).toEqual([]);
  });

  it('needs the two sightings in a row', () => {
    const { watch, failed } = setup([FAILED, RUNNING, FAILED, RUNNING]);
    watch.note(working);
    vi.advanceTimersByTime(10_000);
    expect(failed).toEqual([]);
  });

  it('stops looking when the turn reports its own end or asks for approval', () => {
    for (const state of ['done', 'waiting'] as const) {
      const { watch, failed, screenText } = setup([FAILED]);
      watch.note(working);
      vi.advanceTimersByTime(1_000);
      watch.note({ ...working, state, event: state === 'done' ? 'Stop' : 'PermissionRequest' });
      vi.advanceTimersByTime(10_000);
      expect(failed).toEqual([]);
      expect(screenText).toHaveBeenCalledTimes(1);
    }
  });

  it('stops looking once the launch is gone, or the watch is stopped', () => {
    const gone = setup([null]);
    gone.watch.note(working);
    vi.advanceTimersByTime(10_000);
    expect(gone.screenText).toHaveBeenCalledTimes(1);
    expect(gone.failed).toEqual([]);

    const stopped = setup([FAILED]);
    stopped.watch.note(working);
    stopped.watch.stop();
    vi.advanceTimersByTime(10_000);
    expect(stopped.failed).toEqual([]);
  });
});
