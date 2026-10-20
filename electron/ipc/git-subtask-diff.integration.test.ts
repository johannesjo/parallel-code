import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAllFileDiffs,
  getAllFileDiffsFromBranch,
  getBranchCommitMessages,
  getBranchCommits,
  getChangedFiles,
  getChangedFilesFromBranch,
  getDiffBaseSha,
  getFileDiff,
  getFileDiffFromBranch,
  getWorktreeStatus,
} from './git.js';

const directories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(cwd: string, file: string, content: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

function fixture(parentLanding: 'cherry-pick' | 'fast-forward' = 'cherry-pick') {
  const root = mkdtempSync(join(tmpdir(), 'subtask-diff-'));
  directories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  appendFileSync(join(root, '.git/info/exclude'), '/.worktrees/\n');
  commitFile(root, 'base.txt', 'base\n');
  git(root, 'checkout', '-b', 'parent');
  const parentHead = commitFile(root, 'parent.txt', 'parent work\n');
  const child = join(root, '.worktrees/child');
  git(root, 'worktree', 'add', '-b', 'child', child);
  git(root, 'checkout', 'main');
  if (parentLanding === 'fast-forward') {
    git(root, 'merge', '--ff-only', parentHead);
  } else {
    commitFile(root, 'upstream-before.txt', 'upstream before parent\n');
    // The parent's patch lands with a different SHA, between upstream commits.
    git(root, 'cherry-pick', parentHead);
  }
  commitFile(root, 'upstream-after.txt', 'upstream after parent\n');
  return { root, child };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('subtask diffs after rebasing onto upstream', () => {
  it('keeps the parent baseline while the child still branches from the parent', async () => {
    const { child } = fixture();
    commitFile(child, 'child.txt', 'child work\n');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.message)).toEqual([
      'child.txt',
    ]);
  });

  it('excludes upstream work the child merged in', async () => {
    const { root, child } = fixture();
    const childHead = commitFile(child, 'child.txt', 'child work\n');
    git(child, 'merge', 'main', '-m', 'bring upstream into child');
    const mergeHead = git(child, 'rev-parse', 'HEAD');

    // Both tips are ancestors of the merge, but main does not descend from parent.
    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect(await getAllFileDiffs(child, 'parent')).not.toContain('upstream-');
    expect((await getFileDiff(child, 'upstream-after.txt', 'parent')).diff).toBe('');
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.hash)).toEqual([
      childHead,
      mergeHead,
    ]);
    expect(
      (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
    ).toEqual(['child.txt']);
    expect((await getFileDiffFromBranch(root, 'child', 'upstream-after.txt', 'parent')).diff).toBe(
      '',
    );
    expect((await getFileDiffFromBranch(root, 'child', 'child.txt', 'parent')).diff).toContain(
      '+child work',
    );
    expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
  });

  it('excludes upstream work the child merged in more than once', async () => {
    const { root, child } = fixture();
    commitFile(child, 'child.txt', 'child work\n');
    git(child, 'merge', 'main', '-m', 'first upstream merge');
    commitFile(root, 'upstream-later.txt', 'later upstream work\n');
    git(child, 'merge', 'main', '-m', 'second upstream merge');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
  });

  it('shows merged upstream work when it conflicts with the parent', async () => {
    const { root, child } = fixture();
    commitFile(root, 'parent.txt', 'main rewrote parent work\n');
    commitFile(child, 'child.txt', 'child work\n');
    try {
      git(child, 'merge', 'main', '-m', 'bring upstream into child');
    } catch {
      writeFileSync(join(child, 'parent.txt'), 'resolved\n');
      git(child, 'add', 'parent.txt');
      git(child, 'commit', '--no-edit');
    }

    // No clean parent-plus-upstream snapshot exists, so nothing is folded away.
    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
      'parent.txt',
      'upstream-after.txt',
      'upstream-before.txt',
    ]);
  });

  it('keeps work the child merged in from a branch of its own', async () => {
    const { child } = fixture();
    git(child, 'checkout', '-b', 'child-side');
    commitFile(child, 'side.txt', 'side work\n');
    git(child, 'checkout', 'child');
    commitFile(child, 'child.txt', 'child work\n');
    git(child, 'merge', 'child-side', '-m', 'merge own side branch');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
      'side.txt',
    ]);
  });

  it('keeps child changes mergeable into the parent after main cherry-picks them', async () => {
    const { root, child } = fixture();
    const childHead = commitFile(child, 'child.txt', 'child work\n');
    git(root, 'cherry-pick', childHead);

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect(await getAllFileDiffs(child, 'parent')).toContain('+child work');
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.hash)).toEqual([
      childHead,
    ]);
    expect(
      (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
    ).toEqual(['child.txt']);
    expect(await getWorktreeStatus(child, 'parent')).toMatchObject({
      has_committed_changes: true,
      base_branch: 'parent',
    });
  });

  it.each([false, true])(
    'keeps child changes when main merges them and parent is still missing them (advanced: %s)',
    async (parentAdvanced) => {
      const { root, child } = fixture();
      const childHead = commitFile(child, 'child.txt', 'child work\n');
      git(root, 'merge', 'child', '-m', 'land child on main');
      if (parentAdvanced) {
        git(root, 'checkout', 'parent');
        commitFile(root, 'parent-later.txt', 'parent work after child fork\n');
      }

      expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
        'child.txt',
      ]);
      expect((await getBranchCommits(child, 'parent')).map((commit) => commit.hash)).toEqual([
        childHead,
      ]);
      expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
    },
  );

  it('keeps content authored in a merge commit visible', async () => {
    const { root, child } = fixture('fast-forward');
    const upstreamHead = git(root, 'rev-parse', 'HEAD');
    git(child, 'merge', '--no-ff', '--no-commit', 'main');
    const mergeHead = commitFile(child, 'base.txt', 'child integration fix\n');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual(['base.txt']);
    expect(await getAllFileDiffs(child, 'parent')).toContain('+child integration fix');
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.hash)).not.toContain(
      upstreamHead,
    );
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.hash)).toContain(
      mergeHead,
    );
    expect(
      (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
    ).toEqual(['base.txt']);
    expect(await getWorktreeStatus(child, 'parent')).toMatchObject({
      has_committed_changes: true,
      base_branch: 'parent',
    });
  });

  it('keeps the recorded rebase baseline after main integrates the child', async () => {
    const { root, child } = fixture();
    git(child, 'rebase', 'main');
    const rebaseTarget = git(child, 'rev-parse', 'HEAD');
    commitFile(child, 'child.txt', 'child work\n');
    git(root, 'merge', '--ff-only', 'child');

    expect(await getDiffBaseSha(child, 'parent')).toBe(rebaseTarget);
    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect(
      (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
    ).toEqual(['child.txt']);
    expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
  });

  it('continues excluding inherited work after a second upstream rebase', async () => {
    const { root, child } = fixture();
    git(child, 'rebase', 'main');
    commitFile(child, 'child.txt', 'child work\n');
    const latestTarget = commitFile(root, 'upstream-later.txt', 'later upstream work\n');
    git(child, 'rebase', 'main');

    expect(await getDiffBaseSha(child, 'parent')).toBe(latestTarget);
    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect(
      (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
    ).toEqual(['child.txt']);
    expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
  });

  it.each(['merge', 'cherry-pick'] as const)(
    'preserves child work integrated by %s before a second upstream rebase',
    async (integration) => {
      const { root, child } = fixture();
      git(child, 'rebase', 'main');
      const firstTarget = git(child, 'rev-parse', 'HEAD');
      const childHead = commitFile(child, 'child.txt', 'child work\n');
      if (integration === 'merge') git(root, 'merge', '--ff-only', 'child');
      else git(root, 'cherry-pick', childHead);
      commitFile(root, 'upstream-later.txt', 'later upstream work\n');
      git(child, 'rebase', 'main');

      expect(await getDiffBaseSha(child, 'parent')).toBe(firstTarget);
      expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toContain(
        'child.txt',
      );
      expect(
        (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
      ).toContain('child.txt');
      expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
    },
  );

  it.each(['merge', 'cherry-pick'] as const)(
    'preserves child work when main integrates it by %s before the child rebases',
    async (integration) => {
      const { root, child } = fixture();
      const childHead = commitFile(child, 'child.txt', 'child work\n');
      if (integration === 'merge') git(root, 'merge', 'child', '-m', 'land child on main');
      else git(root, 'cherry-pick', childHead);
      git(child, 'rebase', 'main');

      expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toContain(
        'child.txt',
      );
      expect((await getBranchCommits(child, 'parent')).map((commit) => commit.message)).toContain(
        'child.txt',
      );
      expect(
        (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
      ).toContain('child.txt');
      expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
    },
  );

  it('preserves earlier child commits when an interactive rebase rewrites only the tip', async () => {
    const { child } = fixture();
    commitFile(child, 'child-first.txt', 'first child change\n');
    commitFile(child, 'child-second.txt', 'second child change\n');
    execFileSync(
      'git',
      ['-c', 'sequence.editor=true', 'rebase', '-i', '--force-rebase', 'HEAD~1'],
      {
        cwd: child,
        env: { ...process.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child-first.txt',
      'child-second.txt',
    ]);
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.message)).toEqual([
      'child-first.txt',
      'child-second.txt',
    ]);
  });

  it('retains the parent comparison when the rebase record is unavailable', async () => {
    const { child } = fixture();
    git(child, 'rebase', 'main');
    commitFile(child, 'child.txt', 'child work\n');
    git(child, 'reflog', 'expire', '--expire=all', 'refs/heads/child');

    expect(await getDiffBaseSha(child, 'parent')).toBe(git(child, 'merge-base', 'parent', 'HEAD'));
    expect(await getAllFileDiffs(child, 'parent')).toContain('+child work');
    expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
  });

  it('ignores an old rebase target after the child returns to its parent history', async () => {
    const { child } = fixture();
    git(child, 'rebase', 'main');
    git(child, 'reset', '--hard', 'parent');
    commitFile(child, 'child.txt', 'child work\n');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
  });

  it('does not reuse rebase history after the child resets and authors equivalent work', async () => {
    const { root, child } = fixture();
    git(child, 'rebase', 'main');
    git(child, 'reset', '--hard', 'parent');
    commitFile(child, 'upstream-after.txt', 'upstream after parent\n');
    git(child, 'rebase', 'main');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toContain(
      'upstream-after.txt',
    );
    expect(
      (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
    ).toContain('upstream-after.txt');
    expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
  });

  it('retains inherited history when a reset only discards a later child commit', async () => {
    const { child } = fixture();
    git(child, 'rebase', 'main');
    const target = git(child, 'rev-parse', 'HEAD');
    commitFile(child, 'discarded.txt', 'discarded child work\n');
    git(child, 'reset', '--hard', 'HEAD~1');
    commitFile(child, 'child.txt', 'child work\n');

    expect(await getDiffBaseSha(child, 'parent')).toBe(target);
    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
  });

  it.each([false, true])(
    'excludes inherited upstream changes and preserves child edits (committed: %s)',
    async (hasChildCommit) => {
      const { root, child } = fixture();
      if (hasChildCommit) commitFile(child, 'child.txt', 'child work\n');
      git(child, 'rebase', 'main');
      writeFileSync(join(child, 'base.txt'), 'dirty child work\n');
      writeFileSync(join(child, 'untracked.txt'), 'new child work\n');

      const committedFiles = hasChildCommit ? ['child.txt'] : [];
      const files = await getChangedFiles(child, 'parent');
      expect(files.map((file) => file.path)).toEqual([
        ...committedFiles,
        'base.txt',
        'untracked.txt',
      ]);
      expect(files.filter((file) => file.committed).map((file) => file.path)).toEqual(
        committedFiles,
      );
      const diff = await getAllFileDiffs(child, 'parent');
      expect(diff).toContain('+dirty child work');
      expect(diff).toContain('+new child work');
      expect(diff).not.toContain('upstream-');
      expect(diff).not.toContain('parent.txt');
      expect((await getFileDiff(child, 'base.txt', 'parent')).oldContent).toBe('base\n');
      expect((await getBranchCommits(child, 'parent')).map((commit) => commit.message)).toEqual(
        committedFiles,
      );

      // Closed worktrees use the same comparison through the branch fallback.
      expect(
        (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
      ).toEqual(committedFiles);
      const branchDiff = await getAllFileDiffsFromBranch(root, 'child', 'parent');
      expect(branchDiff).not.toContain('upstream-');
      expect(branchDiff).not.toContain('parent.txt');
      expect(branchDiff).not.toContain('dirty child work');
      expect((await getWorktreeStatus(child, 'parent')).base_branch).toBe('parent');
    },
  );
});

describe('subtask diffs after the parent rewrites its history', () => {
  // Rewritten parent commits are not patch-equivalent to the child's copies
  // (amend, squash, conflict-resolving rebase), so only the parent's reflog
  // still knows where the child forked.
  it('excludes inherited parent work after the parent amends it', async () => {
    const { root, child } = fixture();
    commitFile(child, 'child.txt', 'child work\n');
    git(root, 'checkout', 'parent');
    writeFileSync(join(root, 'parent.txt'), 'parent work, revised\n');
    git(root, 'commit', '-a', '--amend', '--no-edit');
    commitFile(root, 'parent-later.txt', 'later parent work\n');
    git(root, 'checkout', 'main');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.message)).toEqual([
      'child.txt',
    ]);
    expect(
      (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
    ).toEqual(['child.txt']);
  });

  it('keeps child work after the parent fast-forwards to it and is reset', async () => {
    const { root, child } = fixture();
    commitFile(child, 'child.txt', 'child work\n');
    git(root, 'checkout', 'parent');
    git(root, 'merge', '--ff-only', 'child');
    git(root, 'reset', '--hard', 'HEAD~1');
    git(root, 'checkout', 'main');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
  });

  it('keeps task work after main fast-forwards to it and is reset', async () => {
    const { root } = fixture();
    const task = join(root, '.worktrees/task');
    git(root, 'worktree', 'add', '-b', 'task', task, 'main');
    commitFile(task, 'task.txt', 'task work\n');
    git(root, 'merge', '--ff-only', 'task');
    git(root, 'reset', '--hard', 'HEAD~1');

    expect((await getChangedFiles(task, 'main')).map((file) => file.path)).toEqual(['task.txt']);
    expect((await getChangedFiles(task)).map((file) => file.path)).toEqual(['task.txt']);
  });

  it('keeps work committed before the agent switched to a new branch', async () => {
    const { root, child } = fixture();
    commitFile(child, 'child.txt', 'child work\n');
    git(child, 'checkout', '-b', 'child-renamed');
    commitFile(child, 'child-later.txt', 'later child work\n');
    git(root, 'checkout', 'parent');
    git(root, 'commit', '--allow-empty', '--amend', '--no-edit', '-m', 'parent rewritten');
    git(root, 'checkout', 'main');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toContain(
      'child.txt',
    );
  });

  it('excludes rewritten main work a top-level task branched from', async () => {
    const { root } = fixture();
    const task = join(root, '.worktrees/task');
    git(root, 'worktree', 'add', '-b', 'task', task, 'main');
    commitFile(task, 'task.txt', 'task work\n');
    writeFileSync(join(root, 'upstream-after.txt'), 'upstream rewritten\n');
    git(root, 'commit', '-a', '--amend', '--no-edit');

    expect((await getChangedFiles(task, 'main')).map((file) => file.path)).toEqual(['task.txt']);
    expect((await getChangedFiles(task)).map((file) => file.path)).toEqual(['task.txt']);
  });

  it('keeps the merge-base when the parent reflog is unavailable', async () => {
    const { root, child } = fixture();
    commitFile(child, 'child.txt', 'child work\n');
    git(root, 'checkout', 'parent');
    writeFileSync(join(root, 'parent.txt'), 'parent work, revised\n');
    git(root, 'commit', '-a', '--amend', '--no-edit');
    git(root, 'checkout', 'main');
    git(root, 'reflog', 'expire', '--expire=all', 'refs/heads/parent');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
      'parent.txt',
    ]);
  });
});

describe('subtask diffs after the child moves to upstream or loses its parent', () => {
  it('excludes rebased copies of parent work after the child rebases onto main', async () => {
    const { root, child } = fixture();
    git(root, 'checkout', 'parent');
    commitFile(root, 'parent-later.txt', 'parent work main lacks\n');
    git(root, 'checkout', 'main');
    git(child, 'merge', '--ff-only', 'parent');
    commitFile(child, 'child.txt', 'child work\n');
    git(child, 'rebase', 'main');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.message)).toEqual([
      'child.txt',
    ]);
  });

  it.each(['merge', 'pull'] as const)(
    'excludes upstream work the child fast-forwarded onto by %s',
    async (command) => {
      const { root, child } = fixture('fast-forward');
      if (command === 'merge') git(child, 'merge', 'main');
      else git(child, 'pull', '--ff-only', root, 'main');
      commitFile(child, 'child.txt', 'child work\n');

      expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
        'child.txt',
      ]);
      expect((await getBranchCommits(child, 'parent')).map((commit) => commit.message)).toEqual([
        'child.txt',
      ]);
      expect(
        (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
      ).toEqual(['child.txt']);
    },
  );

  it('excludes inherited work after the child pulls main with --rebase', async () => {
    const { root, child } = fixture();
    commitFile(child, 'child.txt', 'child work\n');
    git(child, 'pull', '--rebase', root, 'main');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect((await getBranchCommits(child, 'parent')).map((commit) => commit.message)).toEqual([
      'child.txt',
    ]);
  });

  it('keeps work the child fast-forwarded onto from a branch of its own', async () => {
    const { child } = fixture('fast-forward');
    git(child, 'checkout', '-b', 'child-side');
    commitFile(child, 'side.txt', 'side work\n');
    git(child, 'checkout', 'child');
    git(child, 'merge', 'child-side');
    commitFile(child, 'child.txt', 'child work\n');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
      'side.txt',
    ]);
  });

  it('compares against main after the parent branch is deleted', async () => {
    const { root, child } = fixture();
    commitFile(child, 'child.txt', 'child work\n');
    git(root, 'branch', '-D', 'parent');

    expect((await getChangedFiles(child, 'parent')).map((file) => file.path)).toEqual([
      'child.txt',
    ]);
    expect(
      (await getChangedFilesFromBranch(root, 'child', 'parent')).map((file) => file.path),
    ).toEqual(['child.txt']);
    expect((await getWorktreeStatus(child, 'parent')).has_committed_changes).toBe(true);
  });
});

describe('getBranchCommitMessages', () => {
  it('returns subjects and multi-paragraph bodies, oldest first', async () => {
    const { child } = fixture();
    writeFileSync(join(child, 'a.txt'), 'a\n');
    git(child, 'add', 'a.txt');
    git(child, 'commit', '-m', 'feat: a', '-m', 'First paragraph.\n\nSecond paragraph.');
    commitFile(child, 'b.txt', 'b\n');

    expect(
      (await getBranchCommitMessages(child, 'parent')).map(({ message, body }) => ({
        message,
        body,
      })),
    ).toEqual([
      { message: 'feat: a', body: 'First paragraph.\n\nSecond paragraph.' },
      { message: 'b.txt', body: '' },
    ]);
  });
});
