import { describe, expect, it } from 'vitest';
import type { VerificationRun } from '../ipc/types';
import {
  lastPassText,
  overlapText,
  readinessLine,
  type ReadinessLineInput,
} from './readiness-line';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const HEAD = 'a'.repeat(40);

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    headSha: HEAD,
    dirty: false,
    startedAt: '2026-10-23T11:50:00.000Z',
    finishedAt: '2026-10-23T11:56:00.000Z',
    outputTail: 'ok\n',
    ...overrides,
  };
}

function line(overrides: Partial<ReadinessLineInput> = {}) {
  return readinessLine({
    verifyCommand: 'npm test',
    headSha: HEAD,
    autoRun: true,
    now: NOW,
    ...overrides,
  });
}

describe('readinessLine', () => {
  it('states a pass with the commit and age, in plain text', () => {
    expect(line({ run: run() })).toEqual({
      tone: 'neutral',
      text: 'Verify passed',
      detail: 'on aaaaaaa · 4m ago',
      action: 'rerun',
    });
  });

  it('does not count a pass on another commit', () => {
    expect(line({ run: run({ headSha: 'b'.repeat(40) }) })).toMatchObject({
      tone: 'neutral',
      text: 'Not tested on this commit',
      detail: 'passed on bbbbbbb · 4m ago',
      action: 'run',
    });
  });

  it('says a pass with uncommitted changes does not cover the merge', () => {
    expect(line({ run: run({ dirty: true }) })).toMatchObject({
      text: 'Verify passed with uncommitted changes',
      action: 'run',
    });
  });

  it('colours only a failure, offering a fix prompt that names the last pass', () => {
    const older = 'c'.repeat(40);
    expect(
      line({
        run: run({ status: 'failed', exitCode: 1, outputTail: 'boom\n1 failed\n' }),
        lastPass: { command: 'npm test', headSha: older, finishedAt: 'x' },
        branchCommits: [older, 'd'.repeat(40), HEAD],
      }),
    ).toEqual({
      tone: 'failed',
      text: 'Verify failed (exit 1)',
      detail: '1 failed · last passed 2 commits ago (ccccccc)',
      action: 'stage',
    });
  });

  it('offers a fresh run, not a fix prompt, for a failure on an older commit', () => {
    expect(
      line({ run: run({ status: 'failed', exitCode: 1, headSha: 'b'.repeat(40) }) }),
    ).toMatchObject({ tone: 'failed', action: 'run' });
  });

  it('shows a running check with Cancel', () => {
    expect(line({ run: run({ status: 'running', finishedAt: null }) })).toMatchObject({
      text: 'Verify running',
      detail: '`npm test` · started 10m ago',
      action: 'cancel',
    });
  });

  it('says when the next background run happens', () => {
    expect(line()).toMatchObject({
      text: 'Not tested on this commit',
      detail: "`npm test` runs in the background after the agent's next turn.",
      action: 'run',
    });
    expect(line({ autoRun: false }).detail).toBe('`npm test`');
  });

  it('explains why the background run held this commit back', () => {
    expect(line({ hold: { headSha: HEAD, reason: 'dirty' } }).detail).toBe(
      'Background run held back because the worktree has uncommitted changes.',
    );
    // A hold for an earlier commit says nothing about this one.
    expect(line({ hold: { headSha: 'b'.repeat(40), reason: 'dirty' } }).detail).toContain(
      'runs in the background',
    );
  });

  it('treats a cancelled run as not tested', () => {
    expect(line({ run: run({ status: 'cancelled', exitCode: null }) }).text).toBe(
      'Not tested on this commit',
    );
  });

  it('labels an agent report as a report, and offers setting up a command', () => {
    const verification = {
      checks: [{ name: 'Unit', command: 'npm test', result: 'passed' as const }],
    };
    expect(line({ verifyCommand: undefined, verification })).toMatchObject({
      text: 'Agent reports its checks passed',
      action: 'configure',
    });
    expect(line({ verifyCommand: undefined })).toMatchObject({
      text: 'No verify command',
      action: 'configure',
    });
  });
});

describe('lastPassText', () => {
  const failed = run({ status: 'failed', exitCode: 1 });

  it('falls back to the commit when it is not on the branch any more', () => {
    expect(
      lastPassText(failed, { command: 'npm test', headSha: 'e'.repeat(40), finishedAt: 'x' }, []),
    ).toBe('last passed at eeeeeee');
  });

  it('ignores a pass of another command or of the same commit', () => {
    expect(
      lastPassText(failed, { command: 'npm run x', headSha: 'e'.repeat(40), finishedAt: 'x' }, []),
    ).toBe('');
    expect(lastPassText(failed, { command: 'npm test', headSha: HEAD, finishedAt: 'x' }, [])).toBe(
      '',
    );
  });
});

describe('overlapText', () => {
  it('says when the base commits leave this branch alone', () => {
    expect(overlapText([], 'main')).toBe('None of them touch files this branch changed.');
  });

  it('names the shared files, a few at most', () => {
    expect(overlapText(['a.ts'], 'main')).toBe(
      "They also change 1 file this branch changed: a.ts. Checks here ran without main's version.",
    );
    expect(overlapText(['a', 'b', 'c', 'd', 'e'], 'dev')).toContain('a, b, c and 2 more');
  });
});
