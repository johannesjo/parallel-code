import { expect, it } from 'vitest';
import {
  agentPublication,
  forgetAgentPublication,
  recordAgentPublication,
} from './reasoning-activity';

it('keeps one publication per task and forgets it with the task', () => {
  recordAgentPublication({ taskId: 'a', agentId: 'agent-a', generation: 1 });
  recordAgentPublication({ taskId: 'b', agentId: 'agent-b', generation: 2 });
  expect(agentPublication('a')?.agentId).toBe('agent-a');
  forgetAgentPublication('a');
  expect(agentPublication('a')).toBeUndefined();
  expect(agentPublication('b')?.generation).toBe(2);
});
