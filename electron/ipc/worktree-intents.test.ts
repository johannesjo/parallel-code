import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  reconcileWorktreeIntents,
  recordWorktreeIntent,
  settleWorktreeIntents,
} from './worktree-intents.js';

const tempDirs: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-worktree-intents-'));
  tempDirs.push(root);
  const worktree = path.join(root, 'repo/.worktrees/task/fix-a1b2c3');
  const intent = {
    worktreePath: worktree,
    branchName: 'task/fix-a1b2c3',
    projectRoot: path.join(root, 'repo'),
  };
  return { journal: path.join(root, 'user-data/worktree-intents.json'), worktree, intent };
}

/** Stands in for `git worktree add` having run. */
function provision(worktree: string): void {
  fs.mkdirSync(worktree, { recursive: true });
}

function savedState(...worktreePaths: string[]): string {
  const tasks = Object.fromEntries(worktreePaths.map((p, i) => [`t${i}`, { worktreePath: p }]));
  return JSON.stringify({ tasks });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('worktree intent journal', () => {
  it('reports a worktree provisioned before a crash that preceded the save', () => {
    const { journal, worktree, intent } = setup();
    reconcileWorktreeIntents(journal, null);
    recordWorktreeIntent(intent);
    provision(worktree);

    // Crash: no save. Reopening the journal is what the next start does.
    const orphans = reconcileWorktreeIntents(journal, savedState());

    expect(orphans).toEqual([expect.objectContaining(intent)]);
  });

  it('keeps reporting an orphan on later starts until its worktree is removed', () => {
    const { journal, worktree, intent } = setup();
    reconcileWorktreeIntents(journal, null);
    recordWorktreeIntent(intent);
    provision(worktree);

    expect(reconcileWorktreeIntents(journal, savedState())).toHaveLength(1);
    expect(reconcileWorktreeIntents(journal, savedState())).toHaveLength(1);

    fs.rmSync(worktree, { recursive: true });
    expect(reconcileWorktreeIntents(journal, savedState())).toEqual([]);
  });

  it('forgets a worktree once a saved state claims it', () => {
    const { journal, worktree, intent } = setup();
    reconcileWorktreeIntents(journal, null);
    recordWorktreeIntent(intent);
    provision(worktree);

    settleWorktreeIntents(savedState(worktree));

    expect(reconcileWorktreeIntents(journal, savedState())).toEqual([]);
  });

  it('does not report a worktree the saved state claims when the settle was missed', () => {
    const { journal, worktree, intent } = setup();
    reconcileWorktreeIntents(journal, null);
    recordWorktreeIntent(intent);
    provision(worktree);

    expect(reconcileWorktreeIntents(journal, savedState(worktree))).toEqual([]);
  });

  it('drops an intent whose worktree was never created', () => {
    const { journal, intent } = setup();
    reconcileWorktreeIntents(journal, null);
    recordWorktreeIntent(intent);

    expect(reconcileWorktreeIntents(journal, savedState())).toEqual([]);
    expect(JSON.parse(fs.readFileSync(journal, 'utf8')).intents).toEqual([]);
  });

  it('treats an unreadable journal as empty instead of failing startup', () => {
    const { journal } = setup();
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, '{ not json');

    expect(reconcileWorktreeIntents(journal, null)).toEqual([]);
  });
});
