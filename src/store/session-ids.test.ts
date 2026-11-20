import { describe, expect, it } from 'vitest';
import { assignFreshSessionId } from './session-ids';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('assignFreshSessionId', () => {
  it('gives a Qoder pane an id of its own', () => {
    const draft: { tasks: Record<string, { agentSessionIds?: Record<string, string> }> } = {
      tasks: { t: {} },
    };
    assignFreshSessionId(draft, 't', 'a', 'qoder');
    expect(draft.tasks.t.agentSessionIds?.a).toMatch(ID_RE);
  });

  it('clears the id for an agent that cannot mint one', () => {
    const draft: { tasks: Record<string, { agentSessionIds?: Record<string, string> }> } = {
      tasks: { t: { agentSessionIds: { a: 'old' } } },
    };
    assignFreshSessionId(draft, 't', 'a', 'opencode');
    expect(draft.tasks.t.agentSessionIds).toBeUndefined();
  });
});
