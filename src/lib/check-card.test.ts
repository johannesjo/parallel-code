import { describe, expect, it } from 'vitest';
import type { VerificationRun } from '../ipc/types';
import { checkCard, checkCardOutcome, codeChangedDuringRun } from './check-card';
import type { CardDefinition } from './cards';

function run(over: Partial<VerificationRun>): VerificationRun {
  return {
    command: 'npm run check',
    status: 'passed',
    exitCode: 0,
    headSha: 'a',
    dirty: false,
    headShaAfter: 'a',
    dirtyAfter: false,
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:00:41.000Z',
    outputTail: '',
    ...over,
  };
}

const PASS_FAIL = checkCard({ id: 'verify', name: 'Check' });
const TODOS: CardDefinition = {
  id: 'todos',
  name: 'New TODOs',
  description: '',
  source: { kind: 'check', checkId: 'todos', mode: 'json', trigger: 'manual' },
  slots: [
    { id: 'count', type: 'stat', label: 'Count' },
    { id: 'where', type: 'line', label: 'Where' },
  ],
  enabled: true,
};

describe('checkCardOutcome', () => {
  it('shows pass or fail with exit code and duration in exit-code mode', () => {
    expect(checkCardOutcome(PASS_FAIL, { run: run({}) })).toEqual({
      values: {
        result: { type: 'status', rows: [{ state: 'ok', text: 'Passed', value: 'exit 0 · 41 s' }] },
      },
    });
    const failed = run({ status: 'failed', exitCode: 1, finishedAt: '2026-01-01T10:02:30.000Z' });
    expect(checkCardOutcome(PASS_FAIL, { run: failed })).toEqual({
      values: {
        result: {
          type: 'status',
          rows: [{ state: 'fail', text: 'Failed', value: 'exit 1 · 3 min' }],
        },
      },
    });
  });

  it('keeps the previous values when a run times out, is cancelled or cannot start', () => {
    const timedOut = run({
      status: 'timed_out',
      exitCode: null,
      message: 'Timed out after 10 min',
    });
    expect(checkCardOutcome(PASS_FAIL, { run: timedOut })).toEqual({
      error: 'Timed out after 10 min',
    });
    expect(
      checkCardOutcome(PASS_FAIL, { run: run({ status: 'cancelled', exitCode: null }) }),
    ).toEqual({ error: 'cancelled' });
  });

  it('fills the slots a JSON check wrote, and names a value that does not fit', () => {
    const output = { count: { value: 3 }, where: 'src/a.ts' };
    expect(checkCardOutcome(TODOS, { run: run({}), output })).toEqual({
      values: {
        count: { type: 'stat', value: 3, unit: '' },
        where: { type: 'line', text: 'src/a.ts' },
      },
    });
    const bad = checkCardOutcome(TODOS, { run: run({}), output: { count: 'three' } });
    expect(bad).toEqual({ error: expect.stringContaining('Slot "count"') as string });
  });

  it('fails a JSON check that exits non-zero or writes no usable file', () => {
    const failed = run({ status: 'failed', exitCode: 2 });
    expect(checkCardOutcome(TODOS, { run: failed })).toEqual({ error: 'exit 2' });
    const killed = run({ status: 'failed', exitCode: null, message: 'Killed by SIGKILL' });
    expect(checkCardOutcome(TODOS, { run: killed })).toEqual({ error: 'Killed by SIGKILL' });
    expect(checkCardOutcome(TODOS, { run: run({}), error: 'PC_OUT_FILE missing' })).toEqual({
      error: 'PC_OUT_FILE missing',
    });
  });
});

describe('checkCard', () => {
  it('gives a check id cut to a card id that is taken a numbered one', () => {
    const long = 'lint-typescript-strict-mode-everything-a';
    const first = checkCard({ id: long, name: 'A' }, new Set());
    expect(first.id).toBe('check-lint-typescript-strict-mode-everyt');
    const second = checkCard({ id: `${long}b`, name: 'B' }, new Set([first.id]));
    expect(second.id).toBe('check-lint-typescript-strict-mode-ever-2');
  });
});

describe('codeChangedDuringRun', () => {
  it('tells when HEAD or the uncommitted state moved while the check ran', () => {
    expect(codeChangedDuringRun(run({}))).toBe(false);
    expect(codeChangedDuringRun(run({ headShaAfter: 'b' }))).toBe(true);
    expect(codeChangedDuringRun(run({ dirtyAfter: true }))).toBe(true);
  });
});
