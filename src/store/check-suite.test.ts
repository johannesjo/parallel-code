import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { ChangeScan } from '../../electron/shared/checks';
import type { VerificationRun } from '../ipc/types';

const { mockInvoke, mockSaveState, mockStage, FakeChannel } = vi.hoisted(() => {
  class FakeChannel {
    onmessage: ((msg: unknown) => void) | null = null;
    dispose = vi.fn();
  }
  return {
    mockInvoke: vi.fn(),
    mockSaveState: vi.fn(),
    mockStage: vi.fn(),
    FakeChannel,
  };
});

vi.mock('../lib/ipc', () => ({ invoke: mockInvoke, fireAndForget: vi.fn(), Channel: FakeChannel }));
vi.mock('./persistence', () => ({ saveState: mockSaveState }));
vi.mock('./staged-prompt', () => ({ stageTaskPrompt: mockStage }));

import { setStore, store } from './core';
import type { Project, Task } from './types';
import { runCheckSuite, stageCheckFailurePrompt, stopCheckSuite } from './check-suite';
import { runBackgroundVerify, runTaskVerification } from './verification';

const HEAD = 'a'.repeat(40);
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function scan(overrides: Partial<ChangeScan> = {}): ChangeScan {
  return {
    headSha: HEAD,
    baseSha: 'b'.repeat(40),
    dirty: false,
    files: [],
    flags: [],

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
function answer(result: ChangeScan, runs: Record<string, Partial<VerificationRun>> = {}) {
  mockInvoke.mockImplementation(async (channel: string, args: { command?: string }) => {
    if (channel === IPC.GetChangeScan) return result;
    if (channel === IPC.RunTaskVerification)
      return finished(args.command ?? '', runs[args.command ?? '']);
    return undefined;
  });
}

const runCommands = () =>
  mockInvoke.mock.calls
    .filter(([channel]) => channel === IPC.RunTaskVerification)
    .map(([, args]) => (args as { command: string; checkSuite: boolean }).command);

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

describe('runCheckSuite', () => {
  it.each(['dirty', 'truncated'] as const)('holds checks for a %s scan', async (field) => {
    answer(scan({ [field]: true }));
    await runCheckSuite('t1');
    expect(runCommands()).toEqual([]);
  });

  it.each(['finish', 'stop-before-result', 'stop-after-result'])(
    'reconciles a newer manual failure on %s',
    async (completion) => {
      let release: ((run: VerificationRun) => void) | undefined;
      mockInvoke.mockImplementation(
        async (channel: string, args: { command?: string; checkSuite?: boolean }) => {
          if (channel === IPC.GetChangeScan) return scan();
          if (channel !== IPC.RunTaskVerification) return undefined;
          if (args.command === 'npm test')
            return new Promise<VerificationRun>((resolve) => {
              release = resolve;
            });
          return finished(
            args.command ?? '',
            args.checkSuite
              ? {}
              : {
                  status: 'failed',
                  exitCode: 1,
                  startedAt: 'z',
                },
          );
        },
      );
      const building = runCheckSuite('t1');
      await flush();
      expect(release).toBeDefined();
      await runTaskVerification('t1');
      if (completion === 'stop-before-result') await stopCheckSuite('t1');
      if (completion === 'stop-after-result') {
        mockInvoke.mockImplementationOnce(async () => {
          release?.(finished('npm test', { status: 'cancelled' }));
          await flush();
          return true;
        });
        await stopCheckSuite('t1');
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

  it('stops a background verify first, since the build runs verify itself', async () => {
    let finishBackground: ((run: VerificationRun) => void) | undefined;
    mockInvoke.mockImplementation(async (channel: string, args: { checkSuite?: boolean }) => {
      if (channel === IPC.GetChangeScan)
        return scan({
          files: [{ path: 'a.ts', status: 'M', role: 'source' }],
        });
      if (channel === IPC.RunTaskVerification && !args.checkSuite)
        return new Promise<VerificationRun>((resolve) => (finishBackground = resolve));
      if (channel === IPC.RunTaskVerification) return finished('npm run check');
      if (channel === IPC.CancelTaskVerification && !args.checkSuite) {
        finishBackground?.(finished('npm run check', { status: 'cancelled', exitCode: null }));
        return true;
      }
      return undefined;
    });
    const background = runBackgroundVerify('t1');
    await flush();
    expect(finishBackground).toBeDefined();

    await runCheckSuite('t1');
    await background;

    const channels = mockInvoke.mock.calls.map(([channel, args]) => [
      channel,
      Boolean((args as { checkSuite?: boolean }).checkSuite),
    ]);
    const cancelled = channels.findIndex(
      ([channel, suite]) => channel === IPC.CancelTaskVerification && !suite,
    );
    const buildRun = channels.findIndex(
      ([channel, suite]) => channel === IPC.RunTaskVerification && suite,
    );
    expect(cancelled).toBeGreaterThan(-1);
    expect(cancelled).toBeLessThan(buildRun);
  });

  it('runs auto checks one after another on the suite key and skips on-demand ones', async () => {
    answer(scan());
    await runCheckSuite('t1');
    expect(runCommands()).toEqual(['npm run check', 'npm test']);
    const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.RunTaskVerification);
    expect(call?.[1]).toMatchObject({ checkSuite: true, expectedHeadSha: HEAD });
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

  it('runs only the checks a review picked, on-demand ones included', async () => {
    answer(scan());
    await runCheckSuite('t1', { only: ['e2e', 'unit'] });
    // The project's order, not the pick's; verify was not picked, so it does not run.
    expect(runCommands()).toEqual(['npm test', 'npm run e2e']);
    expect(store.tasks.t1.evidence?.skipped).toEqual([]);
  });

  it('reuses a manual verify run of the same commit instead of running it again', async () => {
    setTask({ verificationRun: finished('npm run check', { status: 'failed', exitCode: 1 }) });
    answer(scan());
    await runCheckSuite('t1');
    expect(runCommands()).toEqual(['npm test']);
    expect(store.tasks.t1.evidence?.checks[0]).toMatchObject({
      checkId: 'verify',
      status: 'failed',
      reused: true,
    });
  });

  it('records the verify check it ran as the task verification run', async () => {
    answer(scan(), { 'npm run check': { status: 'failed', exitCode: 2 } });
    await runCheckSuite('t1');
    expect(store.tasks.t1.verificationRun).toMatchObject({
      command: 'npm run check',
      status: 'failed',
      exitCode: 2,
    });
    expect(store.tasks.t1.verificationRun).not.toHaveProperty('checkId');
  });

  it('keeps a verification run that started after the suite run', async () => {
    const later = finished('npm run check', { headSha: 'c'.repeat(40), startedAt: 'z' });
    setTask({ verificationRun: later });
    answer(scan());
    await runCheckSuite('t1');
    expect(runCommands()).toEqual(['npm run check', 'npm test']);
    expect(store.tasks.t1.verificationRun).toEqual(later);
  });

  it('shows a manual verify run of the same commit in the package', async () => {
    answer(scan());
    await runCheckSuite('t1');
    answer(scan(), { 'npm run check': { status: 'failed', exitCode: 1, startedAt: 'z' } });
    await runTaskVerification('t1');
    expect(store.tasks.t1.evidence?.checks[0]).toMatchObject({
      checkId: 'verify',
      status: 'failed',
      reused: true,
    });
  });

  it('runs nothing unasked for Docker tasks', async () => {
    setTask({ dockerMode: true });
    answer(scan());
    await runCheckSuite('t1');
    expect(runCommands()).toEqual([]);
    expect(store.tasks.t1.evidence?.skipped.map((skip) => skip.reason)).toEqual([
      'docker',
      'docker',
      'on-demand',
    ]);
  });

  it('reports a failed scan without replacing the previous package', async () => {
    answer(scan());
    await runCheckSuite('t1');
    const previous = store.tasks.t1.evidence?.id;
    mockInvoke.mockRejectedValueOnce(new Error('not a git repository'));
    await runCheckSuite('t1');
    expect(store.tasks.t1.evidence?.id).toBe(previous);
  });
});

describe('stageCheckFailurePrompt', () => {
  it('stages the failed checks other than verify, and nothing when they pass', async () => {
    answer(scan(), { 'npm run check': { status: 'failed', exitCode: 1 } });
    await runCheckSuite('t1');
    expect(stageCheckFailurePrompt('t1')).toBe(false);
    answer(scan(), { 'npm test': { status: 'failed', exitCode: 1, outputTail: 'boom' } });
    await runCheckSuite('t1');
    expect(stageCheckFailurePrompt('t1')).toBe(true);
    expect(mockStage).toHaveBeenCalledWith('t1', expect.stringContaining('boom'));
    expect(mockStage).not.toHaveBeenCalledWith('t1', expect.stringContaining('npm run check'));
  });
});
