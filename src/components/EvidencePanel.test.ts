import { renderToString } from 'solid-js/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePackage, ProjectCheck } from '../../electron/shared/evidence';
import { computeEvidenceConfidence } from '../../electron/shared/evidence-confidence';
import type { Task } from '../store/types';

const { state } = vi.hoisted(() => ({
  state: {
    ui: {} as { scanning?: boolean; error?: string; outputs?: Record<string, string> },
    agents: {} as Record<string, { status: string }>,
    when: 'off' as string,
    checks: [] as ProjectCheck[],
  },
}));

vi.mock('../store/store', () => ({
  store: { agents: state.agents },
  getEvidenceUiState: () => state.ui,
  getProject: () => ({ evidenceModel: { when: state.when, provider: 'claude' } }),
  getTaskChecks: () => state.checks,
  getEvidenceConfidence: (
    task: Task,
    git?: { head_sha?: string | null; has_uncommitted_changes?: boolean },
  ) =>
    task.evidence
      ? computeEvidenceConfidence(task.evidence, git?.head_sha, {
          dirty: git?.has_uncommitted_changes,
          checks: state.checks,
        })
      : undefined,
  isEvidenceBusy: (pkg: EvidencePackage) =>
    pkg.assembling || pkg.checks.some((run) => run.status === 'running'),
  buildEvidence: vi.fn(),
  runEvidenceReview: vi.fn(),
  sendEvidenceToAgent: vi.fn(),
  sendVerificationFailureToAgent: vi.fn(),
  getVerificationOutput: () => '',
  runTaskVerification: vi.fn(),
  cancelTaskVerification: vi.fn(),
  cancelEvidenceChecks: vi.fn(),
  stopEvidence: vi.fn(),
  runEvidenceCheck: vi.fn(),
  acceptEvidenceFlag: vi.fn(),
  dismissEvidenceFinding: vi.fn(),
}));

import { EvidencePanel } from './EvidencePanel';
import { EvidenceRunsHelp } from './EvidenceRunsHelp';

const HEAD = 'a'.repeat(40);

function pkg(overrides: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    id: 'p',
    createdAt: 'x',
    trigger: 'agent',
    assembling: false,
    configuredChecks: [
      { id: 'verify', name: 'Verify', kind: 'custom', command: 'npm run check', run: 'auto' },
    ],
    scan: {
      headSha: HEAD,
      baseSha: 'b'.repeat(40),
      dirty: false,
      files: [{ path: 'src/a.ts', status: 'M', added: 1, removed: 0, role: 'source' }],
      flags: [],
      tests: [{ file: 'src/a.test.ts', kind: 'unit', title: 'retries twice', change: 'added' }],
      coveringTests: [],
      sourceWithoutTests: [],
    },
    checks: [
      {
        checkId: 'verify',
        name: 'Verify',
        kind: 'custom',
        command: 'npm run check',
        status: 'passed',
        exitCode: 0,
        headSha: HEAD,
        dirty: false,
        startedAt: 'x',
        finishedAt: 'y',
        outputTail: '',
      },
    ],
    skipped: [],
    claim: { submittedAt: 'x', summary: 'Adds retries' },
    acceptedFlags: {},
    dismissedFindings: [],
    ...overrides,
  };
}

function task(evidence?: EvidencePackage): Task {
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
    evidence,
  };
}

beforeEach(() => {
  state.ui = {};
  state.when = 'off';
  state.checks = [
    { id: 'verify', name: 'Verify', kind: 'custom', command: 'npm run check', run: 'auto' },
  ];
  delete state.agents.a1;
});

describe('EvidencePanel', () => {
  it('offers to build evidence when there is none', () => {
    const html = renderToString(() => EvidencePanel({ task: task() }));
    expect(html).toContain('No evidence yet');
    expect(html).toContain('Build evidence');
    expect(html).not.toContain('submit_evidence');
  });

  it('shows high confidence with the facts behind it', () => {
    const html = renderToString(() => EvidencePanel({ task: task(pkg()), headSha: HEAD }));
    expect(html).toContain('High confidence');
    expect(html).toContain(HEAD.slice(0, 8));
    expect(html).toContain('1 passed');
    expect(html).toContain('retries twice');
    expect(html).toContain('Refresh evidence');
    expect(html).not.toContain('Run AI review');
  });

  it('marks a previously clean package outdated after uncommitted edits', () => {
    const html = renderToString(() =>
      EvidencePanel({ task: task(pkg()), headSha: HEAD, dirty: true }),
    );
    expect(html).toContain('Checks outdated');
    expect(html).toContain('uncommitted changes');
  });

  it('marks the package outdated once the branch moves on', () => {
    const html = renderToString(() =>
      EvidencePanel({ task: task(pkg()), headSha: 'c'.repeat(40) }),
    );
    expect(html).toContain('Checks outdated');
    expect(html).toContain('New commits since the evidence was built.');
  });

  it('puts an open weakened-test flag up front and lets the reviewer accept it', () => {
    const flag = {
      id: 'f',
      category: 'test-weakened' as const,
      rule: 'test-removed',
      file: 'src/a.test.ts',
      line: 4,
      detail: 'Test case removed.',
    };
    const html = renderToString(() =>
      EvidencePanel({ task: task(pkg({ scan: { ...pkg().scan, flags: [flag] } })), headSha: HEAD }),
    );
    expect(html).toContain('Low confidence');
    expect(html).toContain('1 decision needed');
    expect(html).toContain('src/a.test.ts:4');
    expect(html).toContain('Accept…');
  });

  it('keeps stale results out of the headline even when old checks failed', () => {
    const evidence = pkg();
    evidence.checks[0] = { ...evidence.checks[0], status: 'failed', exitCode: 1 };
    const html = renderToString(() => EvidencePanel({ task: task(evidence), headSha: 'new' }));
    expect(html).toMatch(/<strong[^>]*>Checks outdated<\/strong>/);
    expect(html).not.toContain('1 check failed');
  });

  it('describes missing related tests without claiming measured coverage', () => {
    const evidence = pkg();
    evidence.scan.sourceWithoutTests = ['src/a.ts'];
    const html = renderToString(() => EvidencePanel({ task: task(evidence), headSha: HEAD }));
    expect(html).toContain('No related tests found:');
    expect(html).not.toContain('Not covered by tests');
  });

  it('offers Stop while checks run and the model button only when configured', () => {
    state.when = 'manual';
    expect(renderToString(() => EvidencePanel({ task: task(pkg()), headSha: HEAD }))).toContain(
      'Run AI review',
    );
    const busy = renderToString(() =>
      EvidencePanel({ task: task(pkg({ assembling: true })), headSha: HEAD }),
    );
    expect(busy).toContain('Stop');
    expect(busy).not.toContain('Run AI review');
  });

  it('hands failures to a running agent', () => {
    state.agents.a1 = { status: 'running' };
    const failed = pkg();
    failed.checks[0] = { ...failed.checks[0], status: 'failed', exitCode: 1 };
    const html = renderToString(() =>
      EvidencePanel({ task: task(failed), agentId: 'a1', headSha: HEAD }),
    );
    expect(html).toContain('Ask agent to fix');
    expect(html).toContain('1 check failed');
  });
});

describe('EvidencePanel without a package', () => {
  it('still hands a failed verify run to a running agent', () => {
    state.agents.a1 = { status: 'running' };
    const failed = { ...pkg().checks[0], status: 'failed' as const, exitCode: 1 };
    const html = renderToString(() =>
      EvidencePanel({ task: { ...task(), verificationRun: failed }, agentId: 'a1' }),
    );
    expect(html).toContain('Ask agent to fix');
  });
});

describe('EvidencePanel configuration', () => {
  it('offers to configure checks only while none is set up', () => {
    state.checks = [];
    const onConfigure = () => {};
    expect(renderToString(() => EvidencePanel({ task: task(), onConfigure }))).toContain(
      'Configure checks',
    );
    state.checks = [{ id: 'verify', name: 'Verify', kind: 'custom', command: 'x', run: 'auto' }];
    expect(renderToString(() => EvidencePanel({ task: task(), onConfigure }))).not.toContain(
      'Configure checks',
    );
  });
});

describe('EvidenceRunsHelp', () => {
  it('says nothing is executed without checks', () => {
    state.checks = [];
    const html = renderToString(() => EvidenceRunsHelp({ task: task() }));
    expect(html).toContain('nothing is executed');
    expect(html).toContain('The review model is off.');
  });

  it('lists what runs and what waits for a click', () => {
    state.when = 'manual';
    state.checks = [
      { id: 'verify', name: 'Verify', kind: 'custom', command: 'npm run check', run: 'auto' },
      { id: 'e2e-tests', name: 'E2E tests', kind: 'e2e', command: 'npm run e2e', run: 'on-demand' },
    ];
    const html = renderToString(() => EvidenceRunsHelp({ task: task() }));
    expect(html).toContain('npm run check');
    expect(html).toContain('Waits for a click');
    expect(html).toContain('runs on demand only');
    expect(html).toContain('only when you click Run AI review');
  });
});
