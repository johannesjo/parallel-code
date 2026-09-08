import { describe, expect, it } from 'vitest';
import type { VerificationRun } from '../ipc/types';
import {
  compileVerificationFailurePrompt,
  lastOutputLine,
  summarizeVerificationRun,
  usesVerificationRun,
  VERIFY_PROMPT_TAIL_LINES,
} from './verification-run';

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    headSha: 'aaa',
    dirty: false,
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:01:00.000Z',
    outputTail: 'ok\n',
    ...overrides,
  };
}

describe('summarizeVerificationRun', () => {
  it.each([
    ['no run', undefined, 'aaa', 'none', 'Not verified'],
    ['running', run({ status: 'running', finishedAt: null }), 'aaa', 'running', 'Running'],
    ['passed at current HEAD', run(), 'aaa', 'passed', 'Passed'],
    ['passed at an older HEAD', run(), 'bbb', 'stale', 'Verified at an older commit'],
    ['passed without a git pin', run({ headSha: null }), 'bbb', 'passed', 'Passed'],
    ['passed with unknown current HEAD', run(), undefined, 'passed', 'Passed'],
    [
      'passed on a dirty tree',
      run({ dirty: true }),
      'aaa',
      'dirty',
      'Passed with uncommitted changes',
    ],
    ['failed', run({ status: 'failed', exitCode: 1 }), 'aaa', 'failed', 'Failed (exit 1)'],
    [
      'failed at an older HEAD',
      run({ status: 'failed', exitCode: 1 }),
      'bbb',
      'failed',
      'Failed (exit 1) at an older commit',
    ],
    ['timed out', run({ status: 'timed_out', exitCode: null }), 'aaa', 'failed', 'Timed out'],
    ['cancelled', run({ status: 'cancelled', exitCode: null }), 'aaa', 'unavailable', 'Cancelled'],
    ['error', run({ status: 'error', exitCode: null }), 'aaa', 'unavailable', 'Could not run'],
  ])('%s', (_name, input, headSha, kind, label) => {
    const summary = summarizeVerificationRun(input, headSha);
    expect(summary.kind).toBe(kind);
    expect(summary.label).toBe(label);
  });

  it('quotes the last output line of a failure and the error message otherwise', () => {
    const failed = summarizeVerificationRun(
      run({ status: 'failed', exitCode: 2, outputTail: 'suite\n  ✗ adds numbers\n\n' }),
    );
    expect(failed.detail).toBe('✗ adds numbers');

    const noOutput = summarizeVerificationRun(
      run({ status: 'failed', exitCode: null, outputTail: '', message: 'Killed by SIGKILL.' }),
    );
    expect(noOutput.detail).toBe('Killed by SIGKILL.');

    const error = summarizeVerificationRun(
      run({ status: 'error', exitCode: null, message: 'spawn /bin/zsh ENOENT' }),
    );
    expect(error.detail).toBe('spawn /bin/zsh ENOENT');
  });
});

describe('usesVerificationRun', () => {
  it('prefers the app run whenever a command is configured or a run exists', () => {
    expect(usesVerificationRun(undefined, false)).toBe(false);
    expect(usesVerificationRun(undefined, true)).toBe(true);
    expect(usesVerificationRun(run(), false)).toBe(true);
  });
});

describe('lastOutputLine', () => {
  it('skips blank trailing lines', () => {
    expect(lastOutputLine('a\nb  \n\n  \n')).toBe('b');
    expect(lastOutputLine('')).toBe('');
  });
});

describe('compileVerificationFailurePrompt', () => {
  it('names the command, exit code and a bounded output tail', () => {
    const lines = Array.from({ length: VERIFY_PROMPT_TAIL_LINES + 10 }, (_, i) => `line ${i}`);
    const prompt = compileVerificationFailurePrompt(
      run({ status: 'failed', exitCode: 1, outputTail: lines.join('\n') }),
    );

    expect(prompt).toContain('Command: `npm test`');
    expect(prompt).toContain('Exit code: 1');
    expect(prompt).not.toContain('line 9\n');
    expect(prompt).toContain('line 10\n');
    expect(prompt).toContain(`line ${VERIFY_PROMPT_TAIL_LINES + 9}`);
  });

  it('falls back to the run message when there is no exit code', () => {
    const prompt = compileVerificationFailurePrompt(
      run({ status: 'timed_out', exitCode: null, message: 'Timed out after 10 min.' }),
    );
    expect(prompt).toContain('Exit code: Timed out after 10 min.');
  });
});
