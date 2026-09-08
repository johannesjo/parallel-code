import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHookEventPayload } from './status.js';

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock('../log.js', () => ({ error: mockLogError }));

import { emitAgentHookEvent, onAgentHookEvent } from './events.js';

function payload(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return { agentId: 'a1', taskId: 't1', state: 'done', event: 'Stop', at: 1, ...overrides };
}

const unsubscribes: Array<() => void> = [];

afterEach(() => {
  for (const off of unsubscribes.splice(0)) off();
  mockLogError.mockReset();
});

describe('agent hook event bridge', () => {
  it('delivers each event to every listener until it unsubscribes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onAgentHookEvent(first);
    unsubscribes.push(offFirst, onAgentHookEvent(second));

    emitAgentHookEvent(payload());
    offFirst();
    emitAgentHookEvent(payload({ event: 'UserPromptSubmit', state: 'working' }));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('keeps delivering to later listeners when one throws', () => {
    const after = vi.fn();
    unsubscribes.push(
      onAgentHookEvent(() => {
        throw new Error('boom');
      }),
      onAgentHookEvent(after),
    );

    expect(() => emitAgentHookEvent(payload())).not.toThrow();
    expect(after).toHaveBeenCalledWith(payload());
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });
});
