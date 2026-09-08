import { renderToString } from 'solid-js/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationRun } from '../ipc/types';
import type { Task } from '../store/types';

const { state } = vi.hoisted(() => ({
  state: {
    verifyCommand: undefined as string | undefined,
    output: '',
    agents: {} as Record<string, { status: string }>,
  },
}));

vi.mock('../store/store', () => ({
  store: { agents: state.agents },
  getVerifyCommand: () => state.verifyCommand,
  getVerificationOutput: () => state.output,
  runTaskVerification: vi.fn(),
  cancelTaskVerification: vi.fn(),
  sendVerificationFailureToAgent: vi.fn(),
}));

import { VerificationPanel } from './VerificationPanel';

function task(verificationRun?: VerificationRun): Task {
  return {
    id: 't1',
    name: 'Task',
    projectId: 'p1',
    branchName: 'task/t1',
    worktreePath: '/repo/.worktrees/t1',
    agentIds: ['a1'],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    verificationRun,
  };
}

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: 'npm test',
    status: 'failed',
    exitCode: 1,
    headSha: 'sha-1',
    dirty: false,
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:01:00.000Z',
    outputTail: '1 failed: adds numbers\n',
    ...overrides,
  };
}

beforeEach(() => {
  state.verifyCommand = undefined;
  state.output = '';
  delete state.agents.a1;
});

describe('VerificationPanel', () => {
  it('explains how to configure a command when none is set', () => {
    const html = renderToString(() => VerificationPanel({ task: task() }));

    expect(html).toContain('No verify command configured');
    expect(html).toContain('project settings');
    expect(html).not.toContain('>Run<');
  });

  it('shows the failed run, its output, and hands it to a running agent', () => {
    state.verifyCommand = 'npm test';
    state.output = '1 failed: adds numbers\n';
    state.agents.a1 = { status: 'running' };

    const html = renderToString(() =>
      VerificationPanel({ task: task(run()), agentId: 'a1', headSha: 'sha-1' }),
    );

    expect(html).toContain('Failed (exit 1)');
    expect(html).toContain('1 failed: adds numbers');
    expect(html).toContain('Re-run');
    expect(html).toContain('Send to agent');
  });

  it('offers Cancel while a run is in flight and never sends passing runs', () => {
    state.verifyCommand = 'npm test';
    state.agents.a1 = { status: 'running' };

    const running = renderToString(() =>
      VerificationPanel({
        task: task(run({ status: 'running', finishedAt: null })),
        agentId: 'a1',
      }),
    );
    expect(running).toContain('Cancel');
    expect(running).not.toContain('Send to agent');

    const passed = renderToString(() =>
      VerificationPanel({ task: task(run({ status: 'passed', exitCode: 0 })), agentId: 'a1' }),
    );
    expect(passed).toContain('Passed');
    expect(passed).not.toContain('Send to agent');
  });

  it('flags a passing run that predates the current HEAD', () => {
    state.verifyCommand = 'npm test';

    const html = renderToString(() =>
      VerificationPanel({ task: task(run({ status: 'passed', exitCode: 0 })), headSha: 'sha-2' }),
    );

    expect(html).toContain('Verified at an older commit');
  });
});
