import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { EvidenceScan } from '../../electron/shared/evidence';
import type { VerificationRun } from '../ipc/types';

const { mockInvoke, mockSaveState, mockSendPrompt, FakeChannel } = vi.hoisted(() => {
  class FakeChannel {
    onmessage: ((msg: unknown) => void) | null = null;
    dispose = vi.fn();
  }
  return {
    mockInvoke: vi.fn(),
    mockSaveState: vi.fn(),
    mockSendPrompt: vi.fn(),
    FakeChannel,
  };
});

vi.mock('../lib/ipc', () => ({ invoke: mockInvoke, fireAndForget: vi.fn(), Channel: FakeChannel }));
vi.mock('./persistence', () => ({ saveState: mockSaveState }));
vi.mock('./tasks', () => ({ sendPrompt: mockSendPrompt }));

import { setStore, store } from './core';
import type { Project, Task } from './types';
import {
  buildEvidence,
  runEvidenceCheck,
  sendEvidenceToAgent,
  stopEvidence,
  submitEvidence,
} from './evidence';
import {
  acceptEvidenceFlag,
  dismissEvidenceFinding,
  restoreEvidenceFinding,
  reopenEvidenceFlag,
  getEvidenceUiState,
} from './evidence-state';
import { cancelEvidenceChecks } from './evidence';
import { runTaskVerification } from './verification';

const HEAD = 'a'.repeat(40);
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function scan(overrides: Partial<EvidenceScan> = {}): EvidenceScan {
  return {
    headSha: HEAD,
    baseSha: 'b'.repeat(40),
    dirty: false,
    files: [],
    flags: [],
    tests: [],
    coveringTests: [],
    sourceWithoutTests: [],
    ...overrides,
  };
}

function finished(command: string, overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command,
    status: 'passed',
    exitCode: 0,
    headSha: HEAD,
    dirty: false,
    headShaAfter: HEAD,
    dirtyAfter: false,
    startedAt: 'x',
    finishedAt: 'y',
    outputTail: 'ok',
    ...overrides,
  };
}

/** Answers scans with `result` and runs every check successfully. */
function answer(result: EvidenceScan, runs: Record<string, Partial<VerificationRun>> = {}) {
  mockInvoke.mockImplementation(async (channel: string, args: { command?: string }) => {
    if (channel === IPC.GetEvidenceScan) return result;
    if (channel === IPC.RunTaskVerification)
      return finished(args.command ?? '', runs[args.command ?? '']);
    return undefined;
  });
}

const runCommands = () =>
  mockInvoke.mock.calls
    .filter(([channel]) => channel === IPC.RunTaskVerification)
    .map(([, args]) => (args as { command: string; evidence: boolean }).command);

function setTask(overrides: Partial<Task> = {}): void {
  setStore('tasks', {
    t1: {
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
      ...overrides,
    } as Task,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveState.mockResolvedValue(undefined);
  mockSendPrompt.mockResolvedValue(undefined);
  setStore('projects', [
    {
      id: 'p1',
      name: 'Repo',
      path: '/repo',
      verifyCommand: 'npm run check',
      evidenceChecks: [
        { id: 'unit', name: 'Unit', kind: 'unit', command: 'npm test', run: 'auto' },
        { id: 'e2e', name: 'E2E', kind: 'e2e', command: 'npm run e2e', run: 'on-demand' },
      ],
    } as Project,
  ]);
  setStore('taskOrder', ['t1']);
  setTask();
});

describe('buildEvidence', () => {
  it.each(['dirty', 'truncated'] as const)(
    'holds checks for a %s scan but permits a click',
    async (field) => {
      answer(scan({ [field]: true }));
      await buildEvidence('t1', { trigger: 'agent' });
      expect(runCommands()).toEqual([]);
      await runEvidenceCheck('t1', 'unit');
      expect(runCommands()).toEqual(['npm test']);
      const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.RunTaskVerification);
      expect(call?.[1].expectedHeadSha).toBeUndefined();
    },
  );

  it.each(['finish', 'stop-before-result', 'stop-after-result'])(
    'reconciles a newer manual failure on %s',
    async (completion) => {
      let release: ((run: VerificationRun) => void) | undefined;
      mockInvoke.mockImplementation(
        async (channel: string, args: { command?: string; evidence?: boolean }) => {
          if (channel === IPC.GetEvidenceScan) return scan();
          if (channel !== IPC.RunTaskVerification) return undefined;
          if (args.command === 'npm test')
            return new Promise<VerificationRun>((resolve) => {
              release = resolve;
            });
          return finished(
            args.command ?? '',
            args.evidence
              ? {}
              : {
                  status: 'failed',
                  exitCode: 1,
                  startedAt: 'z',
                },
          );
        },
      );
      const building = buildEvidence('t1', { trigger: 'manual' });
      await flush();
      expect(release).toBeDefined();
      await runTaskVerification('t1');
      if (completion === 'stop-before-result') await stopEvidence('t1');
      if (completion === 'stop-after-result') {
        mockInvoke.mockImplementationOnce(async () => {
          release?.(finished('npm test', { status: 'cancelled' }));
          await flush();
          return true;
        });
        await stopEvidence('t1');
      } else
        release?.(finished('npm test', completion === 'finish' ? {} : { status: 'cancelled' }));
      await building;
      expect(store.tasks.t1.evidence?.checks.find((run) => run.checkId === 'verify')).toMatchObject(
        {
          status: 'failed',
          startedAt: 'z',
        },
      );
    },
  );

  it('runs auto checks one after another on the evidence key and skips on-demand ones', async () => {
    answer(scan());
    await buildEvidence('t1', { trigger: 'manual' });
    expect(runCommands()).toEqual(['npm run check', 'npm test']);
    const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.RunTaskVerification);
    expect(call?.[1]).toMatchObject({ evidence: true, expectedHeadSha: HEAD });
    const pkg = store.tasks.t1.evidence;
    expect(pkg?.assembling).toBe(false);
    expect(pkg?.checks.map((run) => [run.checkId, run.status])).toEqual([
      ['verify', 'passed'],
      ['unit', 'passed'],
    ]);
    expect(pkg?.skipped).toEqual([
      { checkId: 'e2e', name: 'E2E', kind: 'e2e', reason: 'on-demand' },
    ]);
    expect(mockSaveState).toHaveBeenCalled();
  });

  it('reuses a manual verify run of the same commit instead of running it again', async () => {
    setTask({ verificationRun: finished('npm run check', { status: 'failed', exitCode: 1 }) });
    answer(scan());
    await buildEvidence('t1', { trigger: 'manual' });
    expect(runCommands()).toEqual(['npm test']);
    expect(store.tasks.t1.evidence?.checks[0]).toMatchObject({
      checkId: 'verify',
      status: 'failed',
      reused: true,
    });
  });

  it('records the verify check it ran as the task verification run', async () => {
    answer(scan(), { 'npm run check': { status: 'failed', exitCode: 2 } });
    await buildEvidence('t1', { trigger: 'manual' });
    expect(store.tasks.t1.verificationRun).toMatchObject({
      command: 'npm run check',
      status: 'failed',
      exitCode: 2,
    });
    expect(store.tasks.t1.verificationRun).not.toHaveProperty('checkId');
  });

  it('keeps a verification run that started after the evidence run', async () => {
    const later = finished('npm run check', { headSha: 'c'.repeat(40), startedAt: 'z' });
    setTask({ verificationRun: later });
    answer(scan());
    await buildEvidence('t1', { trigger: 'manual' });
    expect(runCommands()).toEqual(['npm run check', 'npm test']);
    expect(store.tasks.t1.verificationRun).toEqual(later);
  });

  it('shows a manual verify run of the same commit in the package', async () => {
    answer(scan());
    await buildEvidence('t1', { trigger: 'manual' });
    answer(scan(), { 'npm run check': { status: 'failed', exitCode: 1, startedAt: 'z' } });
    await runTaskVerification('t1');
    expect(store.tasks.t1.evidence?.checks[0]).toMatchObject({
      checkId: 'verify',
      status: 'failed',
      reused: true,
    });
  });

  it('skips an auto build when HEAD has not moved or nothing changed', async () => {
    const file = {
      path: 'src/a.ts',
      status: 'M' as const,
      added: 1,
      removed: 0,
      role: 'source' as const,
    };
    answer(scan({ files: [] }));
    await buildEvidence('t1', { trigger: 'auto' });
    expect(store.tasks.t1.evidence).toBeUndefined();
    answer(scan({ files: [file] }));
    await buildEvidence('t1', { trigger: 'auto' });
    const first = store.tasks.t1.evidence;
    expect(first?.trigger).toBe('auto');
    mockInvoke.mockClear();
    await buildEvidence('t1', { trigger: 'auto' });
    expect(store.tasks.t1.evidence?.id).toBe(first?.id);
    expect(runCommands()).toEqual([]);
  });

  it('never interrupts a build in flight for an auto build', async () => {
    answer(scan());
    await buildEvidence('t1', { trigger: 'manual' });
    const pkg = store.tasks.t1.evidence;
    if (!pkg) throw new Error('missing package');
    setTask({ evidence: { ...pkg, assembling: true } });
    mockInvoke.mockClear();
    await buildEvidence('t1', { trigger: 'auto' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('runs nothing unasked for Docker tasks, but a click still runs the check', async () => {
    setTask({ dockerMode: true });
    answer(scan());
    await buildEvidence('t1', { trigger: 'agent' });
    expect(runCommands()).toEqual([]);
    expect(store.tasks.t1.evidence?.skipped.map((skip) => skip.reason)).toEqual([
      'docker',
      'docker',
      'on-demand',
    ]);
    await runEvidenceCheck('t1', 'unit');
    expect(runCommands()).toEqual(['npm test']);
    expect(store.tasks.t1.evidence?.skipped.map((skip) => skip.checkId)).toEqual(['verify', 'e2e']);
  });

  it('keeps accepted flags that still apply and drops the rest', async () => {
    const flag = {
      id: 'test-removed:1',
      category: 'test-weakened' as const,
      rule: 'test-removed',
      file: 'a.test.ts',
      detail: 'x',
    };
    answer(scan({ flags: [flag] }));
    await buildEvidence('t1', { trigger: 'manual' });
    acceptEvidenceFlag('t1', flag.id, 'Obsolete test');
    acceptEvidenceFlag('t1', 'gone', 'Old');
    await buildEvidence('t1', { trigger: 'manual' });
    expect(store.tasks.t1.evidence?.acceptedFlags).toEqual({ [flag.id]: 'Obsolete test' });
  });

  it('reports a failed scan without replacing the previous package', async () => {
    answer(scan());
    await buildEvidence('t1', { trigger: 'manual' });
    const previous = store.tasks.t1.evidence?.id;
    mockInvoke.mockRejectedValueOnce(new Error('not a git repository'));
    await buildEvidence('t1', { trigger: 'manual' });
    expect(store.tasks.t1.evidence?.id).toBe(previous);
  });
});

describe('runEvidenceCheck', () => {
  it('runs different checks side by side, each with its own output and cancel', async () => {
    answer(scan({ dirty: true }));
    await buildEvidence('t1', { trigger: 'manual' });
    const pending = new Map<string, (run: VerificationRun) => void>();
    const channels = new Map<string, InstanceType<typeof FakeChannel>>();
    mockInvoke.mockImplementation(
      async (
        channel: string,
        args: { checkId?: string; command?: string; onOutput?: InstanceType<typeof FakeChannel> },
      ) => {
        if (channel !== IPC.RunTaskVerification || !args.checkId) return true;
        if (args.onOutput) channels.set(args.checkId, args.onOutput);
        return new Promise<VerificationRun>((resolve) => pending.set(args.checkId ?? '', resolve));
      },
    );

    const unit = runEvidenceCheck('t1', 'unit');
    const e2e = runEvidenceCheck('t1', 'e2e');
    await flush();
    // A second click on a check that is already running starts nothing new.
    await runEvidenceCheck('t1', 'unit');
    expect(runCommands()).toEqual(['npm test', 'npm run e2e']);

    channels.get('unit')?.onmessage?.('unit output');
    channels.get('e2e')?.onmessage?.('e2e output');
    expect(getEvidenceUiState('t1').outputs).toEqual({
      unit: 'unit output',
      e2e: 'e2e output',
    });

    await cancelEvidenceChecks('t1', 'unit');
    expect(mockInvoke).toHaveBeenCalledWith(IPC.CancelTaskVerification, {
      taskId: 't1',
      evidence: true,
      checkId: 'unit',
    });

    pending.get('unit')?.(finished('npm test'));
    pending.get('e2e')?.(finished('npm run e2e', { status: 'failed', exitCode: 1 }));
    await Promise.all([unit, e2e]);
    const statuses = store.tasks.t1.evidence?.checks.map((run) => [run.checkId, run.status]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        ['unit', 'passed'],
        ['e2e', 'failed'],
      ]),
    );
    expect(getEvidenceUiState('t1').outputs).toEqual({});
  });
});

describe('submitEvidence', () => {
  it('records the claim and builds in the background', async () => {
    answer(scan());
    expect(submitEvidence('t1', { summary: 'Done', notVerified: ['Safari'] })).toMatchObject({
      status: 'building',
    });
    await flush();
    await flush();
    expect(store.tasks.t1.evidence).toMatchObject({
      trigger: 'agent',
      claim: { summary: 'Done', notVerified: ['Safari'] },
    });
  });

  it('rejects an unknown task', () => {
    expect(() => submitEvidence('nope', {})).toThrow('Task not found');
  });
});

describe('sendEvidenceToAgent', () => {
  it('sends failures to the agent and nothing when all is well', async () => {
    answer(scan());
    await buildEvidence('t1', { trigger: 'manual' });
    expect(await sendEvidenceToAgent('t1', 'a1')).toBe(false);
    answer(scan(), { 'npm test': { status: 'failed', exitCode: 1, outputTail: 'boom' } });
    await buildEvidence('t1', { trigger: 'manual' });
    expect(await sendEvidenceToAgent('t1', 'a1')).toBe(true);
    expect(mockSendPrompt).toHaveBeenCalledWith('t1', 'a1', expect.stringContaining('boom'));
  });
});

it('records successful delivery without resolving the issue, and invalidates the receipt on rebuild', async () => {
  answer(scan());
  await buildEvidence('t1', {
    trigger: 'manual',
    claim: { submittedAt: 'x', notVerified: ['Browser behavior'] },
  });
  const packageId = store.tasks.t1.evidence?.id;
  const question = { kind: 'gap' as const, index: 0 };
  mockSendPrompt.mockRejectedValueOnce(new Error('offline'));
  await expect(sendEvidenceToAgent('t1', 'a1', question, packageId)).rejects.toThrow('offline');
  expect(store.tasks.t1.evidence?.sentToAgent).toBeUndefined();
  expect(await sendEvidenceToAgent('t1', 'a1', question, packageId)).toBe(true);
  expect(store.tasks.t1.evidence?.sentToAgent).toEqual([JSON.stringify(question)]);
  expect(store.tasks.t1.evidence?.claim?.notVerified).toEqual(['Browser behavior']);
  await buildEvidence('t1', { trigger: 'manual' });
  expect(store.tasks.t1.evidence?.sentToAgent).toBeUndefined();
  expect(await sendEvidenceToAgent('t1', 'a1', question, packageId)).toBe(false);
});

it('can undo accepted flags and dismissed findings', async () => {
  answer(scan());
  await buildEvidence('t1', { trigger: 'manual' });
  acceptEvidenceFlag('t1', 'flag', 'Intentional');
  dismissEvidenceFinding('t1', 'finding');
  reopenEvidenceFlag('t1', 'flag');
  restoreEvidenceFinding('t1', 'finding');
  expect(store.tasks.t1.evidence?.acceptedFlags).toEqual({});
  expect(store.tasks.t1.evidence?.dismissedFindings).toEqual([]);
});
