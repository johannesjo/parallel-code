import { describe, expect, it } from 'vitest';
import {
  appFactCard,
  appFactPending,
  appFactValues,
  diffStats,
  type AppFactInput,
} from './app-facts';

const NOW = 10 * 60_000;
const base: AppFactInput = { turns: 0, now: NOW };

describe('diffStats', () => {
  it('counts changed lines and files, not the file headers', () => {
    const raw = [
      'diff --git a/a.sql b/a.sql',
      '--- a/a.sql',
      '+++ b/a.sql',
      '@@ -1,2 +1,2 @@',
      '--- an SQL comment removed',
      '+-- its replacement',
      ' context',
      'diff --git a/b.ts b/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/b.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
    ].join('\n');
    expect(diffStats(raw)).toEqual({ added: 3, removed: 1, files: 2 });
    expect(diffStats('')).toEqual({ added: 0, removed: 0, files: 0 });
  });
});

describe('appFactValues', () => {
  it('waits for the tracker before showing diff, branch and commit facts', () => {
    expect(appFactValues('diff-size', base)).toBeUndefined();
    expect(appFactValues('branch-health', base)).toBeUndefined();
    expect(appFactValues('commits', base)).toBeUndefined();
    expect(appFactValues('activity', base)).toBeUndefined();
    expect(appFactValues('ci', base)).toBeUndefined();
  });

  it('shows the diff size, warning only past the limit', () => {
    const facts = { diff: { added: 412, removed: 87, files: 9, at: 5 } };
    expect(appFactValues('diff-size', { ...base, facts })).toEqual({
      at: 5,
      values: {
        lines: { type: 'line', text: '+412 −87' },
        files: { type: 'stat', value: 9, unit: 'files' },
        changed: { type: 'stat', value: 499, unit: 'lines' },
      },
    });
    const changed = appFactCard('diff-size', true).slots.find((slot) => slot.id === 'changed');
    expect(changed?.limit).toBe(1_000);
  });

  it('puts a conflict first on the branch-health card', () => {
    const facts = {
      merge: { behind: 4, conflicts: ['src/q.ts', 'src/r.ts'], base: 'main', at: 5 },
    };
    expect(appFactValues('branch-health', { ...base, facts, uncommitted: true })?.values).toEqual({
      status: {
        type: 'status',
        rows: [
          { state: 'fail', text: 'Conflicts with main in 2 files', value: 'src/q.ts' },
          { state: 'unknown', text: 'Behind main by 4 commits' },
          { state: 'unknown', text: 'Uncommitted changes' },
        ],
      },
    });
    const clean = { merge: { behind: 0, conflicts: [], base: 'main', at: 5 } };
    expect(appFactValues('branch-health', { ...base, facts: clean })?.values.status).toEqual({
      type: 'status',
      rows: [
        { state: 'ok', text: 'No conflicts with main' },
        { state: 'ok', text: 'Up to date with main' },
      ],
    });
  });

  it('describes the current stretch and the last prompt', () => {
    const input = {
      ...base,
      turns: 3,
      lastTurnAt: NOW - 12 * 60_000,
      state: { kind: 'waiting' as const, since: NOW - 2 * 60_000 },
    };
    expect(appFactValues('activity', input)?.values).toEqual({
      turns: { type: 'stat', value: 3, unit: 'turns' },
      now: { type: 'line', text: 'Waiting on you for 2m' },
      last: { type: 'line', text: 'Last prompt 12m' },
    });
    const working = { ...input, state: { kind: 'working' as const, since: NOW - 1_000 } };
    expect(appFactValues('activity', working)?.values.now).toEqual({
      type: 'line',
      text: 'Working, just started',
    });
  });

  it('lists failing checks under the CI summary', () => {
    const ci = {
      passing: 2,
      pending: 1,
      failing: 1,
      checkedAt: 7,
      checks: [
        { name: 'lint', bucket: 'pass' },
        { name: 'test', bucket: 'fail' },
      ],
    };
    expect(appFactValues('ci', { ...base, ci })).toEqual({
      at: 7,
      values: {
        runs: {
          type: 'status',
          rows: [
            { state: 'fail', text: '2/4 passed', value: '1 running' },
            { state: 'fail', text: 'test' },
          ],
        },
      },
    });
  });
});

describe('the Plan card', () => {
  it("shows the goal and the agent's steps, naming a failed command under the current one", () => {
    const values = appFactValues('plan', {
      ...base,
      goal: 'Fix the login redirect',
      plan: {
        steps: [
          { step: 'Read the auth flow', status: 'completed' },
          { step: 'Run the tests', status: 'in_progress' },
          { step: 'Open a PR', status: 'pending' },
        ],
        failedCommand: 'npm test',
        at: 5,
      },
    });
    expect(values).toEqual({
      at: 5,
      values: {
        goal: { type: 'line', text: 'Fix the login redirect' },
        steps: {
          type: 'checklist',
          items: [
            { text: 'Read the auth flow', state: 'done' },
            { text: 'Run the tests (npm test failed)', state: 'current' },
            { text: 'Open a PR', state: 'todo' },
          ],
        },
      },
    });
  });

  it('shows the goal alone before a plan, and nothing without either', () => {
    expect(appFactValues('plan', { ...base, goal: 'Fix it', lastTurnAt: 3 })).toEqual({
      at: 3,
      values: { goal: { type: 'line', text: 'Fix it' } },
    });
    expect(appFactValues('plan', { ...base, plan: { steps: [] } })).toBeUndefined();
  });

  it('keeps every step of a long plan, so its count stays true', () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({
      step: `Step ${i + 1}`,
      status: 'pending' as const,
    }));
    const value = appFactValues('plan', { ...base, plan: { steps } })?.values.steps;
    expect(value?.type === 'checklist' && value.items).toHaveLength(20);
  });
});

describe('the remote-branch card', () => {
  const merge = { behind: 0, conflicts: [], base: 'main', at: 5 };
  const rows = (remote: 'unpushed' | 'differs' | 'pushed', uncommitted = false) => {
    const input = { ...base, facts: { merge: { ...merge, remote } }, uncommitted };
    const status = appFactValues('remote-branch', input)?.values.status;
    return status?.type === 'status' ? status.rows : undefined;
  };

  it('says when origin has the latest commit', () => {
    expect(rows('pushed')).toEqual([{ state: 'ok', text: 'Origin has the latest commit' }]);
  });

  it('says when the branch was never pushed or origin is at another commit', () => {
    expect(rows('unpushed')).toEqual([{ state: 'unknown', text: 'Not on origin yet' }]);
    expect(rows('differs')).toEqual([{ state: 'unknown', text: 'Origin is at another commit' }]);
  });

  it('counts the commits not pushed and the ones only origin has', () => {
    const differing = (ahead: number, behind: number) => {
      const facts = {
        merge: { ...merge, remote: 'differs' as const, remoteDivergence: { ahead, behind } },
      };
      const status = appFactValues('remote-branch', { ...base, facts })?.values.status;
      return status?.type === 'status' ? status.rows : undefined;
    };
    expect(differing(2, 0)).toEqual([{ state: 'unknown', text: '2 commits not pushed' }]);
    expect(differing(0, 1)).toEqual([{ state: 'unknown', text: 'Behind origin by 1 commit' }]);
    expect(differing(1, 3)).toEqual([
      { state: 'unknown', text: '1 commit not pushed' },
      { state: 'unknown', text: '3 commits only on origin' },
    ]);
  });

  it('adds uncommitted changes, which no push would carry', () => {
    expect(rows('pushed', true)).toEqual([
      { state: 'ok', text: 'Origin has the latest commit' },
      { state: 'unknown', text: 'Uncommitted changes' },
    ]);
  });

  it('ends with how long ago origin was last fetched or pushed to', () => {
    const now = 3 * 86_400_000 + 10_000;
    const facts = { merge: { ...merge, remote: 'pushed' as const, remoteSeenAt: 10_000 } };
    const status = appFactValues('remote-branch', { ...base, facts, now })?.values.status;
    expect(status?.type === 'status' && status.rows).toEqual([
      { state: 'ok', text: 'Origin has the latest commit' },
      { state: 'unknown', text: 'Last fetch or push', value: '3d ago' },
    ]);
  });

  it('shows nothing for a branch without a remote, and is dated by the read', () => {
    expect(appFactValues('remote-branch', { ...base, facts: { merge } })).toBeUndefined();
    const input = { ...base, facts: { merge: { ...merge, remote: 'pushed' as const } } };
    expect(appFactValues('remote-branch', input)?.at).toBe(5);
    expect(appFactPending('remote-branch')).toBe(
      'after the next turn, on worktree tasks with an origin remote',
    );
  });
});

describe('appFactPending', () => {
  it('tells that branch facts fill only on worktree tasks, so a direct task does not wait forever', () => {
    expect(appFactPending('branch-health')).toBe('after the next turn, on worktree tasks');
    expect(appFactPending('commits')).toBe('after the next turn, on worktree tasks');
    expect(appFactPending('diff-size')).toBe('after the next turn');
  });
});
