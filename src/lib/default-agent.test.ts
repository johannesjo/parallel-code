import { describe, expect, it } from 'vitest';

import type { AgentDef } from '../ipc/types';
import { pickDefaultAgent } from './default-agent';

function agent(id: string, available?: boolean): AgentDef {
  return {
    id,
    name: id,
    command: id,
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
    available,
  };
}

describe('pickDefaultAgent', () => {
  it('keeps the last used agent when it is installed', () => {
    const agents = [agent('a', true), agent('b', true)];
    expect(pickDefaultAgent(agents, 'b')?.id).toBe('b');
  });

  it('skips uninstalled agents for a first task', () => {
    const agents = [agent('claude', false), agent('codex', true)];
    expect(pickDefaultAgent(agents, null)?.id).toBe('codex');
    expect(pickDefaultAgent(agents, 'removed-agent')?.id).toBe('codex');
  });

  it('keeps the last used agent even when the host lacks it (Docker tasks)', () => {
    const agents = [agent('claude', false), agent('codex', true)];
    expect(pickDefaultAgent(agents, 'claude')?.id).toBe('claude');
  });

  it('treats custom agents without a detection flag as installed', () => {
    const agents = [agent('claude', false), agent('custom')];
    expect(pickDefaultAgent(agents, null)?.id).toBe('custom');
  });

  it('falls back to the first agent when none is installed', () => {
    const agents = [agent('a', false), agent('b', false)];
    expect(pickDefaultAgent(agents, null)?.id).toBe('a');
    expect(pickDefaultAgent([], null)).toBeNull();
  });
});
