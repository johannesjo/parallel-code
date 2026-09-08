import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';

const { mockMarkAgentSpawned, mockRefreshUsage } = vi.hoisted(() => ({
  mockMarkAgentSpawned: vi.fn(),
  mockRefreshUsage: vi.fn(),
}));
const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<{ agents: Record<string, AgentLike> }> | undefined,
}));

let mockAgents: Record<string, AgentLike> = {};

interface AgentLike {
  id: string;
  taskId: string;
  def: AgentDefLike;
  resumed: boolean;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: string | null;
  lastOutput: string[];
  generation: number;
  spawnDelayMs?: number;
  attachExisting?: boolean;
}

interface AgentDefLike {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  skip_permissions_args: string[];
  description: string;
}

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness({
    get agents() {
      return mockAgents;
    },
    set agents(next) {
      mockAgents = next;
    },
  });
  return core.harness.moduleMock();
});

vi.mock('./taskStatus', () => ({
  markAgentSpawned: mockMarkAgentSpawned,
  refreshTaskStatus: vi.fn(),
  clearAgentActivity: vi.fn(),
}));

vi.mock('./persistence', () => ({ saveState: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./usage')>()),
  refreshUsage: mockRefreshUsage,
}));

import { markAgentExited, restartAgent, switchAgent } from './agents';

const codexDef: AgentDefLike = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  args: [],
  resume_args: ['resume', '--last'],
  skip_permissions_args: [],
  description: '',
};

function exitedAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    id: 'agent-1',
    taskId: 'task-1',
    def: codexDef,
    resumed: false,
    status: 'exited',
    exitCode: 1,
    signal: '1',
    lastOutput: ['interrupted'],
    generation: 2,
    spawnDelayMs: 500,
    attachExisting: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const harness = expectDefined(core.harness, 'mock store harness');
  harness.reset(harness.state());
  mockAgents = { 'agent-1': exitedAgent() };
});

describe('restartAgent', () => {
  it('marks the next terminal mount as an explicit process replacement', () => {
    restartAgent('agent-1', true);

    expect(mockAgents['agent-1']).toMatchObject({
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      resumed: true,
      generation: 3,
      attachExisting: false,
    });
    expect(mockAgents['agent-1'].spawnDelayMs).toBeUndefined();
    expect(mockMarkAgentSpawned).toHaveBeenCalledWith('agent-1');
  });
});

describe('switchAgent', () => {
  it('marks the next terminal mount as an explicit process replacement', () => {
    const claudeDef: AgentDefLike = {
      ...codexDef,
      id: 'claude',
      name: 'Claude',
      command: 'claude',
    };

    switchAgent('agent-1', claudeDef);

    expect(mockAgents['agent-1']).toMatchObject({
      def: claudeDef,
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      resumed: false,
      generation: 3,
      attachExisting: false,
    });
    expect(mockAgents['agent-1'].spawnDelayMs).toBeUndefined();
    expect(mockMarkAgentSpawned).toHaveBeenCalledWith('agent-1');
  });
});

describe('markAgentExited', () => {
  const exitInfo = { exit_code: 0, signal: null, last_output: ['bye'] };

  it('records the exit and refreshes Claude usage for a Claude Code agent', () => {
    mockAgents = {
      'agent-1': exitedAgent({ status: 'running', def: { ...codexDef, id: 'claude-code' } }),
    };

    markAgentExited('agent-1', exitInfo);

    expect(mockAgents['agent-1']).toMatchObject({
      status: 'exited',
      exitCode: 0,
      lastOutput: ['bye'],
    });
    expect(mockRefreshUsage).toHaveBeenCalledTimes(1);
    expect(mockRefreshUsage).toHaveBeenCalledWith('claude');
  });

  it('refreshes Codex usage for a Codex agent', () => {
    mockAgents = { 'agent-1': exitedAgent({ status: 'running' }) };

    markAgentExited('agent-1', exitInfo);

    expect(mockRefreshUsage).toHaveBeenCalledWith('codex');
  });

  it('leaves usage alone when an agent without a tracked meter exits', () => {
    mockAgents = {
      'agent-1': exitedAgent({ status: 'running', def: { ...codexDef, id: 'gemini' } }),
    };

    markAgentExited('agent-1', exitInfo);

    expect(mockAgents['agent-1'].status).toBe('exited');
    expect(mockRefreshUsage).not.toHaveBeenCalled();
  });
});
