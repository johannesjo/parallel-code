import { expect, it } from 'vitest';
import {
  activationBlocker,
  canQueueActivation,
  CANVAS_TOOLS_PENDING,
  CANVAS_TOOLS_UNAVAILABLE,
  type ActivationInput,
} from './live-activation';

const ready: ActivationInput = {
  hasSource: true,
  agentStatus: 'running',
  canvasTools: true,
  closing: false,
  awaitingInitialPrompt: false,
  askingQuestion: false,
  terminalInputPending: false,
  idle: true,
};

it('is ready only when the running agent has tools and nothing is pending', () => {
  expect(activationBlocker(ready)).toBe('');
  expect(canQueueActivation(ready)).toBe(true);
});

it('keeps a queued request waiting while tools are unknown but drops it when they are unavailable', () => {
  expect(activationBlocker({ ...ready, canvasTools: undefined })).toBe(CANVAS_TOOLS_PENDING);
  expect(activationBlocker({ ...ready, canvasTools: false })).toBe(CANVAS_TOOLS_UNAVAILABLE);
  expect(canQueueActivation({ ...ready, canvasTools: undefined })).toBe(true);
  expect(canQueueActivation({ ...ready, canvasTools: false })).toBe(false);
});

it('words the exited and busy blockers for the mind map', () => {
  expect(activationBlocker({ ...ready, agentStatus: 'exited' }, 'mindmap')).toBe(
    'Start the agent before sending changes.',
  );
  expect(activationBlocker({ ...ready, idle: false }, 'mindmap')).toBe(
    'Wait until the agent is idle.',
  );
  expect(activationBlocker({ ...ready, canvasTools: false }, 'mindmap')).toBe(
    CANVAS_TOOLS_UNAVAILABLE,
  );
});

it('reports the first blocker in priority order', () => {
  expect(activationBlocker({ ...ready, hasSource: false })).toContain('No agent session');
  expect(activationBlocker({ ...ready, agentStatus: 'exited' })).toContain('Start the agent');
  expect(canQueueActivation({ ...ready, agentStatus: 'exited' })).toBe(false);
  expect(activationBlocker({ ...ready, closing: true })).toContain('closing');
  expect(activationBlocker({ ...ready, hookState: 'waiting' })).toContain('question');
  expect(activationBlocker({ ...ready, askingQuestion: true })).toContain('question');
  expect(activationBlocker({ ...ready, terminalInputPending: true })).toContain('unsent input');
  expect(activationBlocker({ ...ready, hookState: 'working' })).toContain('still working');
  expect(activationBlocker({ ...ready, idle: false })).toContain('when it is ready');
});
