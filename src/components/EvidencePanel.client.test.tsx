import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  restoreEvidenceFinding: vi.fn(),
  reopenEvidenceFlag: vi.fn(),
}));

import { EvidencePanel } from './EvidencePanel';
import { sendEvidenceToAgent, restoreEvidenceFinding, reopenEvidenceFlag } from '../store/store';
import { theme } from '../lib/theme';

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
  state.checks = pkg().configuredChecks ?? [];
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.resetAllMocks();
  delete state.agents.a1;
});

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it('keeps failed sends open, allows retry, and closes only after successful delivery', async () => {
  state.agents.a1 = { status: 'running' };
  const evidence = pkg();
  evidence.checks[0] = { ...evidence.checks[0], status: 'failed', exitCode: 1 };
  const close = vi.fn();
  vi.mocked(sendEvidenceToAgent)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(true);
  dispose = render(
    () => <EvidencePanel task={task(evidence)} headSha={HEAD} agentId="a1" onSentToAgent={close} />,
    document.body,
  );
  expect(button('Ask agent to fix').style.background).toBe(theme.accent);
  button('Ask agent to fix').click();
  await flush();
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not send');
  button('Ask agent to fix').click();
  await flush();
  expect(sendEvidenceToAgent).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
});

it('opens the flagged file from the review action and from its location', () => {
  const evidence = pkg();
  evidence.scan.flags = [
    {
      id: 'f',
      category: 'needs-decision',
      rule: 'execution-surface',
      file: 'vitest.config.ts',
      line: 4,
      detail: 'Test exclusions changed.',
    },
  ];
  const open = vi.fn();
  dispose = render(
    () => <EvidencePanel task={task(evidence)} headSha={HEAD} onReviewFile={open} />,
    document.body,
  );
  expect(button('Review change').style.background).toBe(theme.accent);
  button('Review change').click();
  button('vitest.config.ts:4').click();
  expect(open.mock.calls).toEqual([
    ['vitest.config.ts', 4, 'new'],
    ['vitest.config.ts', 4, 'new'],
  ]);
});

it('shows open issues before passed checks and keeps resolved items reversible', () => {
  const evidence = pkg();
  evidence.scan.flags = [
    {
      id: 'accepted',
      category: 'needs-decision',
      rule: 'config',
      file: 'config.ts',
      detail: 'Config changed',
    },
  ];
  evidence.acceptedFlags = { accepted: 'Intentional' };
  evidence.review = {
    status: 'done',
    provider: 'claude',
    headSha: HEAD,
    findings: [
      { id: 'open', severity: 'concern', file: 'src/a.ts', line: 2, text: 'Open finding' },
      {
        id: 'dismissed',
        severity: 'concern',
        file: 'src/a.ts',
        line: 3,
        text: 'Dismissed finding',
      },
    ],
  };
  evidence.dismissedFindings = ['dismissed'];
  dispose = render(() => <EvidencePanel task={task(evidence)} headSha={HEAD} />, document.body);
  const text = document.body.textContent ?? '';
  expect(text.indexOf('Open finding')).toBeLessThan(text.indexOf('Supporting evidence'));
  expect(text.indexOf('Supporting evidence')).toBeLessThan(text.indexOf('Verify'));
  button('Undo dismissal').click();
  button('Undo acceptance').click();
  expect(restoreEvidenceFinding).toHaveBeenCalledWith('t1', 'dismissed');
  expect(reopenEvidenceFlag).toHaveBeenCalledWith('t1', 'accepted');
});

it('previews only the selected gap and retries a failed send', async () => {
  state.agents.a1 = { status: 'running' };
  const evidence = pkg({ claim: { submittedAt: 'x', notVerified: ['Browser behavior'] } });
  vi.mocked(sendEvidenceToAgent)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(true);
  dispose = render(
    () => <EvidencePanel task={task(evidence)} headSha={HEAD} agentId="a1" />,
    document.body,
  );
  button('Ask agent about this').click();
  expect(document.querySelector('pre')?.textContent).toContain(
    'Agent-reported verification gap: Browser behavior',
  );
  button('Send to agent').click();
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not send');
  button('Send to agent').click();
  await flush();
  expect(sendEvidenceToAgent).toHaveBeenLastCalledWith('t1', 'a1', { kind: 'gap', index: 0 }, 'p');
  expect(document.body.textContent).toContain('Browser behavior');
});

it('keeps sent gaps visible until fresh evidence replaces the package', () => {
  state.agents.a1 = { status: 'running' };
  const [evidence, setEvidence] = createSignal(
    pkg({
      claim: { submittedAt: 'x', notVerified: ['Browser behavior'] },
      sentToAgent: [JSON.stringify({ kind: 'gap', index: 0 })],
    }),
  );
  dispose = render(
    () => <EvidencePanel task={task(evidence())} headSha={HEAD} agentId="a1" />,
    document.body,
  );
  expect(document.body.textContent).toContain('Sent to agent · awaiting fresh evidence');
  expect(document.querySelector('[aria-label="Needs attention"]')?.textContent).toContain(
    'Browser behavior',
  );
  setEvidence(pkg({ id: 'fresh', claim: { submittedAt: 'y', notVerified: ['Browser behavior'] } }));
  expect(document.body.textContent).not.toContain('Sent to agent');
  expect(button('Ask agent about this')).toBeDefined();
});
