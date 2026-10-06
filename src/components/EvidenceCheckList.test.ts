import { renderToString } from 'solid-js/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePackage, ProjectCheck } from '../../electron/shared/evidence';
import type { VerificationRun } from '../ipc/types';
import type { Task } from '../store/types';

const { state } = vi.hoisted(() => ({
  state: { checks: [] as ProjectCheck[], output: '' },
}));

vi.mock('../store/store', () => ({
  getTaskChecks: () => state.checks,
  getVerificationOutput: () => state.output,
  runTaskVerification: vi.fn(),
  cancelTaskVerification: vi.fn(),
  runEvidenceCheck: vi.fn(),
  cancelEvidenceChecks: vi.fn(),
}));

import { EvidenceCheckList } from './EvidenceCheckList';

const HEAD = 'a'.repeat(40);
const VERIFY: ProjectCheck = {
  id: 'verify',
  name: 'Verify',
  kind: 'custom',
  command: 'npm run check',
  run: 'auto',
};
const E2E: ProjectCheck = {
  id: 'e2e-tests',
  name: 'E2E tests',
  kind: 'e2e',
  command: 'npm run e2e',
  run: 'on-demand',
};

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: 'npm run check',
    status: 'failed',
    exitCode: 1,
    headSha: HEAD,
    dirty: false,
    startedAt: '2026-10-06T10:00:00.000Z',
    finishedAt: '2026-10-06T10:01:00.000Z',
    outputTail: '1 failed: adds numbers\n',
    ...overrides,
  };
}

function task(verificationRun?: VerificationRun): Task {
  return {
    id: 't1',
    name: 'Task',
    projectId: 'p1',
    branchName: 'task/t1',
    worktreePath: '/repo/.worktrees/t1',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    verificationRun,
  };
}

function pkg(overrides: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    id: 'p',
    createdAt: 'x',
    trigger: 'manual',
    assembling: false,
    scan: {
      headSha: HEAD,
      baseSha: 'b'.repeat(40),
      dirty: false,
      files: [],
      flags: [],
      tests: [],
      coveringTests: [],
      sourceWithoutTests: [],
    },
    checks: [],
    skipped: [{ checkId: 'e2e-tests', name: 'E2E tests', kind: 'e2e', reason: 'on-demand' }],
    acceptedFlags: {},
    dismissedFindings: [],
    ...overrides,
  };
}

const render = (props: Partial<Parameters<typeof EvidenceCheckList>[0]> = {}) =>
  renderToString(() => EvidenceCheckList({ task: task(), headSha: HEAD, busy: false, ...props }));

beforeEach(() => {
  state.checks = [VERIFY, E2E];
  state.output = '';
});

describe('EvidenceCheckList', () => {
  it('renders nothing without configured checks', () => {
    state.checks = [];
    expect(render()).toBe('');
  });

  it('marks verify as required and runs only it before a package exists', () => {
    const html = render();
    expect(html).toContain('required to land');
    expect(html.match(/Not run/g)).toHaveLength(2);
    expect(html.match(/>Run</g)).toHaveLength(1);
  });

  it('does not label a new command with the previous command result', () => {
    const previous = {
      ...run({ status: 'passed' }),
      checkId: 'verify',
      name: 'Verify',
      kind: 'custom' as const,
    };
    state.checks = [{ ...VERIFY, command: 'npm run new-check' }];
    const html = render({
      task: task(run({ status: 'passed' })),
      pkg: pkg({ checks: [previous] }),
    });
    expect(html).toContain('npm run new-check');
    expect(html).toContain('Not run');
    expect(html).not.toContain('Passed');
  });

  it('shows a failed verify run with its output and offers a re-run', () => {
    const html = render({ task: task(run()) });
    expect(html).toContain('Failed (exit 1)');
    expect(html).toContain('1 failed: adds numbers');
    expect(html).toContain('Re-run');
  });

  it('offers Cancel and live output while a run is in flight', () => {
    state.output = 'running suite 3 of 9';
    const html = render({ task: task(run({ status: 'running', finishedAt: null })) });
    expect(html).toContain('Cancel');
    expect(html).toContain('running suite 3 of 9');
  });

  it('keeps other checks runnable while one evidence check runs', () => {
    const unit: ProjectCheck = {
      ...E2E,
      id: 'unit',
      name: 'Unit',
      kind: 'unit',
      command: 'npm test',
    };
    state.checks = [VERIFY, E2E, unit];
    const running = {
      ...run({ command: E2E.command, status: 'running', finishedAt: null, exitCode: null }),
      checkId: E2E.id,
      name: E2E.name,
      kind: E2E.kind,
    };
    const props = {
      pkg: pkg({ checks: [running], skipped: [] }),
      outputs: { [E2E.id]: 'e2e live' },
    };

    const html = render(props);
    expect(html).toContain('Cancel');
    expect(html).toContain('e2e live');
    expect(html.match(/>Run</g)).toHaveLength(2);
    expect(html).not.toContain('disabled');
    // A build runs its checks itself; single runs wait for it.
    expect(render({ ...props, busy: true })).toContain('disabled');
  });

  it('explains held-back checks and lets the reviewer run them once a package exists', () => {
    const html = render({ pkg: pkg() });
    expect(html).toContain('Waiting for your click: runs on demand only');
    expect(html.match(/>Run</g)).toHaveLength(2);
  });

  it('shows the newer of the package result and the manual verify run', () => {
    const evidence = { ...run({ status: 'passed', exitCode: 0 }), checkId: 'verify' };
    const older = pkg({ checks: [{ ...evidence, name: 'Verify', kind: 'custom' }] });
    const newer = run({ startedAt: '2026-10-06T11:00:00.000Z' });
    expect(render({ task: task(newer), pkg: older })).toContain('Failed (exit 1)');
    expect(render({ task: task(), pkg: older })).toContain('Passed');
  });
});
