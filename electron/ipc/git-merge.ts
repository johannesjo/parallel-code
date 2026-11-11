// Integrating a task branch: merge status checks, the merge itself (with the
// project's Kanban board and other local changes set aside around it), pushing,
// and rebasing or merging the base branch into the task.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Notify } from './notify.js';
import { KANBAN_FILE } from './kanban.js';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import { debug as logDebug } from '../log.js';
import { exec, MAX_BUFFER } from './git-exec.js';
import {
  detectMainBranch,
  detectOneWayDiffRange,
  detectRepoLockKey,
  getCurrentBranchName,
  invalidateDiffBaseCache,
} from './git-diff-base.js';
import { getBranchWorktreePath, removeWorktree, withWorktreeLock } from './git-worktree.js';
import {
  baseUpstreamDivergence,
  conflictSourcesNote,
  fastForwardBaseToTaskStart,
  upstreamOf,
} from './git-base-upstream.js';
import type {
  MergeResult,
  MergeStatus,
  MergeTargetChanges,
  RemoteBranchState,
} from './shared-types.js';

const STDERR_CAP = 4096; // cap for stderr buffers in spawned git processes

function parseConflictPath(line: string): string | null {
  const trimmed = line.trim();

  // Format: "CONFLICT (...): Merge conflict in <path>"
  const mergeConflictIdx = trimmed.indexOf('Merge conflict in ');
  if (mergeConflictIdx !== -1) {
    const p = trimmed.slice(mergeConflictIdx + 'Merge conflict in '.length).trim();
    return p || null;
  }

  if (!trimmed.startsWith('CONFLICT')) return null;

  // Format: "CONFLICT (...): path <marker>"
  const parenClose = trimmed.indexOf('): ');
  if (parenClose === -1) return null;
  const afterParen = trimmed.slice(parenClose + 3);

  const markers = [' deleted in ', ' modified in ', ' added in ', ' renamed in ', ' changed in '];
  let cutoff = Infinity;
  for (const m of markers) {
    const idx = afterParen.indexOf(m);
    if (idx !== -1 && idx < cutoff) cutoff = idx;
  }

  const candidate = (cutoff === Infinity ? afterParen : afterParen.slice(0, cutoff)).trim();
  return candidate || null;
}

async function computeBranchDiffStats(
  projectRoot: string,
  mainBranch: string,
  branchName: string,
): Promise<{ linesAdded: number; linesRemoved: number }> {
  const diffRange = await detectOneWayDiffRange(projectRoot, branchName, mainBranch);
  const { stdout } = await exec('git', ['diff', '--numstat', diffRange], {
    cwd: projectRoot,
    maxBuffer: MAX_BUFFER,
  });
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    linesAdded += parseInt(parts[0], 10) || 0;
    linesRemoved += parseInt(parts[1], 10) || 0;
  }
  return { linesAdded, linesRemoved };
}

/**
 * Unstaged edits to the project's Kanban board, which the app makes as tasks
 * move: ` M KANBAN.md` or `?? KANBAN.md`. Staged or conflicted states are not
 * the app's doing and are left to block a merge like any other change.
 */
function isUnstagedKanbanLine(line: string): boolean {
  return (line[0] === ' ' || line[0] === '?') && line.slice(3) === KANBAN_FILE;
}

/** Uncommitted changes that block a merge: all of them except unstaged board edits. */
export function blockingStatusLines(porcelain: string): string[] {
  return porcelain.split('\n').filter((line) => line.trim() && !isUnstagedKanbanLine(line));
}

/**
 * The board as committed at HEAD, with the checkout's line-ending filters
 * applied so it compares with the working copy (CRLF on many Windows
 * checkouts); empty when HEAD has none (untracked or absent).
 */
async function committedBoard(mergeRoot: string): Promise<string> {
  const opts = { cwd: mergeRoot, maxBuffer: MAX_BUFFER };
  const { stdout: entry } = await exec(
    'git',
    ['ls-tree', '--name-only', 'HEAD', '--', KANBAN_FILE],
    opts,
  );
  if (!entry.trim()) return '';
  const { stdout } = await exec('git', ['cat-file', '--filters', `HEAD:${KANBAN_FILE}`], opts);
  return stdout;
}

/**
 * Three-way merge of the local board edits onto the board a merge committed,
 * via `git merge-file`. Null when the two sides' edits overlap.
 */
async function mergeBoardText(
  mergeRoot: string,
  sides: { local: Buffer; base: string; merged: string },
): Promise<string | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kanban-merge-'));
  const files = [path.join(dir, 'local'), path.join(dir, 'base'), path.join(dir, 'merged')];
  try {
    await fs.promises.writeFile(files[0], sides.local);
    await fs.promises.writeFile(files[1], sides.base);
    await fs.promises.writeFile(files[2], sides.merged);
    const { stdout } = await exec('git', ['merge-file', '-p', ...files], {
      cwd: mergeRoot,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    // merge-file exits with the number of conflicts (1-127); anything else is a real failure.
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number' && code > 0 && code < 128) return null;
    throw err;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

const KANBAN_CLASH_WARNING =
  `${KANBAN_FILE} keeps your local edits: the board changes the task committed ` +
  `could not be combined with them and are only in the commit.`;

/**
 * Moves unstaged Kanban board edits out of the way for a merge and returns
 * a function that puts them back. The file returns to its committed state (or
 * is removed when untracked), so the merge, its checkout and any recovery
 * (`reset --hard`) run on a clean tree and can never touch the board's edits.
 *
 * Putting them back compares the board at HEAD before and after the merge.
 * Unchanged: the saved text is written back as is. Changed (the task branch
 * committed board edits): the saved edits are merged onto the new board with
 * `git merge-file`, so the branch's changes are not reverted in the working
 * copy (#337). When the edits overlap, the saved text is written back and the
 * function resolves to a warning naming the board, since the file then lacks
 * changes that are in the commit.
 */
export async function setAsideKanbanEdits(
  mergeRoot: string,
  porcelain: string,
): Promise<() => Promise<string | undefined>> {
  const line = porcelain.split('\n').find(isUnstagedKanbanLine);
  if (!line) return async () => undefined;
  const target = path.join(mergeRoot, KANBAN_FILE);
  const saved = await fs.promises.readFile(target);
  const base = await committedBoard(mergeRoot);
  if (line.startsWith('??')) await fs.promises.unlink(target);
  else await exec('git', ['checkout', '--', KANBAN_FILE], { cwd: mergeRoot });
  return async () => {
    let text: Buffer | string = saved;
    let warning: string | undefined;
    try {
      const merged = await committedBoard(mergeRoot);
      if (merged !== base) {
        const combined = await mergeBoardText(mergeRoot, { local: saved, base, merged });
        if (combined === null) warning = KANBAN_CLASH_WARNING;
        else text = combined;
      }
    } catch (err) {
      console.warn(`Failed to merge ${KANBAN_FILE} edits after merge:`, err);
      warning = KANBAN_CLASH_WARNING;
    }
    try {
      atomicWriteFileSync(target, text);
    } catch (err) {
      console.warn(`Failed to restore ${KANBAN_FILE} after merge:`, err);
    }
    return warning;
  };
}

const PATH_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Undoes git's C-style quoting of a path: `"my notes.txt"`, `"caf\303\251.txt"`. */
function unquotePath(quoted: string): string {
  if (!quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const chars = [...quoted.slice(1, -1)];
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? '';
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = chars[++i] ?? '';
    if (/[0-7]/.test(next)) {
      // Octal escapes are single bytes of a UTF-8 sequence.
      bytes.push(parseInt(chars.slice(i, i + 3).join(''), 8));
      i += 2;
    } else bytes.push(PATH_ESCAPES[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Paths named by `git status --porcelain` lines; a rename names both sides.
 * shortcut: a path containing ` -> ` splits wrongly — parse `-z` output if that matters.
 */
function statusPaths(lines: string[]): string[] {
  return lines.flatMap((line) => line.slice(3).split(' -> ').map(unquotePath));
}

/**
 * Uncommitted changes in `cwd` (except unstaged board edits), and those of
 * them `to` changed since it diverged from `from`. Bringing `to` in would
 * change those files under the user's edits, so a stash could not be put
 * back cleanly.
 */
async function uncommittedOverlap(
  cwd: string,
  from: string,
  to: string,
): Promise<{ files: string[]; overlap: string[]; porcelain: string }> {
  // Every untracked file, not just its directory, so paths compare one to one.
  const { stdout: porcelain } = await exec(
    'git',
    ['--no-optional-locks', 'status', '--porcelain', '-uall'],
    { cwd },
  );
  const files = statusPaths(blockingStatusLines(porcelain));
  if (!files.length) return { files, overlap: [], porcelain };
  // -z: unquoted paths, as statusPaths returns them.
  const { stdout } = await exec(
    'git',
    ['diff', '--name-only', '-z', '--no-renames', `${from}...${to}`, '--'],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  const changed = new Set(stdout.split('\0').filter(Boolean));
  return { files, overlap: files.filter((file) => changed.has(file)), porcelain };
}

/** `a, b, c and 2 more`: short enough for an error message. */
function fileList(files: string[], max = 5): string {
  const shown = files.slice(0, max).join(', ');
  return files.length > max ? `${shown} and ${files.length - max} more` : shown;
}

/** Git's own explanation of a failed command, without Node's "Command failed: …" preamble. */
function gitErrorText(e: unknown): string {
  const stderr = typeof e === 'object' && e !== null ? (e as { stderr?: unknown }).stderr : null;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return e instanceof Error ? e.message : String(e);
}

/** Files left unmerged by a stopped merge or rebase; read before aborting it. */
async function conflictedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function findStash(
  cwd: string,
  message: string,
): Promise<{ sha: string; ref: string } | undefined> {
  const { stdout } = await exec('git', ['stash', 'list', '--format=%H%x00%gd%x00%gs'], { cwd });
  for (const line of stdout.split('\n')) {
    const [sha, ref, subject] = line.split('\0');
    if (sha && ref && subject?.endsWith(message)) return { sha, ref };
  }
  return undefined;
}

/**
 * Stashes the tracked changes in `mergeRoot` for a merge and returns a
 * function that puts them back, staged state included. It resolves to a
 * warning when they could not be put back, or `keep` asks to leave them; the
 * stash then stays for the user.
 * Untracked files stay in place: neither the merge nor its recovery
 * (`reset --hard`, `merge --abort`) removes them.
 */
async function setAsideLocalChanges(
  mergeRoot: string,
  branchName: string,
): Promise<(keep?: boolean) => Promise<string | undefined>> {
  const message = `Parallel Code: set aside to merge ${branchName} (${new Date().toISOString()})`;
  await exec('git', ['stash', 'push', '-m', message], { cwd: mergeRoot });
  const kept = `Your uncommitted changes in ${mergeRoot} could not be put back; they are saved in the stash “${message}”.`;
  // The stash list is shared with every worktree, so find ours by its message.
  const stash = await findStash(mergeRoot, message).catch((err: unknown) => {
    console.warn('git stash list failed after stashing for a merge:', err);
    return 'unknown' as const;
  });
  if (stash === 'unknown') return async () => kept;
  // Only untracked files: git had nothing to stash.
  if (!stash) return async () => undefined;
  return async (keep = false) => {
    // Applied on another commit than they were made on, they would land on the wrong branch.
    if (keep) return kept;
    try {
      await exec('git', ['stash', 'apply', '--index', stash.sha], { cwd: mergeRoot });
    } catch (err) {
      console.warn('git stash apply failed after merge:', err);
      return kept;
    }
    // Other stashes may have been pushed meanwhile: look the entry up again.
    const current = await findStash(mergeRoot, message).catch(() => undefined);
    if (current)
      await exec('git', ['stash', 'drop', current.ref], { cwd: mergeRoot }).catch((err) =>
        console.warn('git stash drop failed after merge:', err),
      );
    return undefined;
  };
}

/**
 * Where origin's copy of the checked-out branch stands. Reads the local
 * remote-tracking ref without fetching, so it costs no network; pushes from
 * the app update that ref.
 */
async function remoteBranchState(worktreePath: string): Promise<RemoteBranchState | undefined> {
  const read = (args: string[]) =>
    exec('git', args, { cwd: worktreePath }).then(
      ({ stdout }) => stdout.trim(),
      () => undefined,
    );
  const [origin, branch, head] = await Promise.all([
    read(['config', '--get', 'remote.origin.url']),
    read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    read(['rev-parse', 'HEAD']),
  ]);
  if (!origin || !branch || !head) return undefined;
  const remote = await read(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (!remote) return 'unpushed';
  return remote === head ? 'pushed' : 'differs';
}

/**
 * `projectRoot`, when given, adds the uncommitted changes of the checkout a
 * merge of this task would run in.
 */
export async function checkMergeStatus(
  worktreePath: string,
  baseBranch?: string,
  projectRoot?: string,
): Promise<MergeStatus> {
  const remote = remoteBranchState(worktreePath);
  const status = await checkBaseStatus(worktreePath, baseBranch);
  const [target, divergence] = await Promise.all([
    projectRoot ? mergeTargetChanges(projectRoot, worktreePath, status.base_branch) : undefined,
    baseUpstreamDivergence(worktreePath, status.base_branch).catch((err: unknown) => {
      // The merge does not depend on it; a missing notice must not hide the rest.
      logDebug('git', `baseUpstreamDivergence failed for ${worktreePath}: ${err}`);
      return undefined;
    }),
  ]);
  const state = await remote;
  return {
    ...status,
    ...(state && { remote: state }),
    ...(target && { target_uncommitted: target }),
    ...(divergence && { base_upstream: divergence }),
  };
}

/** Mirrors where `mergeTask` merges: the base's own worktree, else the project root. */
async function mergeTargetChanges(
  projectRoot: string,
  worktreePath: string,
  mainBranch: string,
): Promise<MergeTargetChanges | undefined> {
  try {
    const mergeRoot = (await getBranchWorktreePath(projectRoot, mainBranch))?.path ?? projectRoot;
    const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    const { files, overlap } = await uncommittedOverlap(mergeRoot, mainBranch, head.trim());
    return files.length ? { path: mergeRoot, files, overlap } : undefined;
  } catch (err) {
    // The merge checks again; a missing notice must not hide the rest of the status.
    logDebug('git', `mergeTargetChanges failed for ${projectRoot}: ${err}`);
    return undefined;
  }
}

/**
 * Every commit of the branch has a patch-equivalent on the base, e.g. after a
 * cherry-pick. Merging it then could only conflict where the base changed
 * those lines since. A pick edited while resolving a conflict, or squashed,
 * has another patch-id and does not count.
 */
async function isAlreadyLanded(worktreePath: string, mainBranch: string): Promise<boolean> {
  const git = (args: string[]) => exec('git', args, { cwd: worktreePath });
  try {
    const [cherry, merges] = await Promise.all([
      // Marks each commit found on the base with `-`; skips merge commits.
      git(['cherry', mainBranch, 'HEAD']),
      git(['rev-list', '--count', '--merges', `${mainBranch}..HEAD`]),
    ]);
    // A merge commit can carry work of its own, such as a conflict resolution,
    // that no patch-id check sees; closing the task could then lose it.
    if (parseInt(merges.stdout.trim(), 10) !== 0) return false;
    const lines = cherry.stdout.split('\n').filter(Boolean);
    return lines.length > 0 && lines.every((line) => line.startsWith('-'));
  } catch (err) {
    // Not landed is today's status: the dialog stays as it was.
    logDebug('git', `isAlreadyLanded failed for ${worktreePath}: ${err}`);
    return false;
  }
}

async function checkBaseStatus(worktreePath: string, baseBranch?: string): Promise<MergeStatus> {
  const mainBranch = baseBranch ?? (await detectMainBranch(worktreePath));
  if (await isAlreadyLanded(worktreePath, mainBranch)) {
    return {
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: mainBranch,
      already_landed: true,
    };
  }

  // Count main commits not in HEAD, excluding patch-equivalents already
  // applied via rebase/cherry-pick. Mirrors the `--cherry-pick --right-only`
  // filter `refineDiffBaseWithCherryPick` uses on the diff side, so the
  // dialog doesn't demand a needless rebase when HEAD's history already
  // carries main's recent commits with different SHAs. Unlike the diff-side
  // helper we *don't* pass `--no-merges`: it's load-bearing there for `%H %P`
  // single-parent parsing, but here it would silently drop merge commits
  // that brought genuinely-new content into main (so-called "evil merges"),
  // turning a real "rebase first" warning into a quiet zero.
  let mainAheadCount = 0;
  try {
    const { stdout } = await exec(
      'git',
      ['rev-list', '--count', '--cherry-pick', '--right-only', `HEAD...${mainBranch}`],
      { cwd: worktreePath },
    );
    mainAheadCount = parseInt(stdout.trim(), 10) || 0;
  } catch {
    /* ignore */
  }

  if (mainAheadCount === 0) {
    return { main_ahead_count: 0, conflicting_files: [], base_branch: mainBranch };
  }

  const conflictingFiles: string[] = [];
  try {
    await exec('git', ['merge-tree', '--write-tree', 'HEAD', mainBranch], { cwd: worktreePath });
  } catch (e: unknown) {
    // merge-tree prints its conflict messages to stdout, which Node keeps on
    // the error rather than in its message.
    const stdout = typeof e === 'object' && e !== null ? (e as { stdout?: unknown }).stdout : null;
    const output = `${String(e)}\n${typeof stdout === 'string' ? stdout : ''}`;
    for (const line of output.split('\n')) {
      const p = parseConflictPath(line);
      if (p) conflictingFiles.push(p);
    }
  }

  const uncommitted = await uncommittedOverlap(worktreePath, 'HEAD', mainBranch)
    .then((changes) => changes.overlap)
    .catch(() => []);
  return {
    main_ahead_count: mainAheadCount,
    conflicting_files: conflictingFiles,
    base_branch: mainBranch,
    overlapping_files: await overlappingFiles(worktreePath, mainBranch, conflictingFiles),
    ...(uncommitted.length && { uncommitted_overlap: uncommitted }),
  };
}

/**
 * Paths both sides changed since they diverged, minus the conflicting ones.
 * The base side counts only commits `main_ahead_count` counts: one already
 * cherry-picked from this branch changes nothing this branch has not seen.
 */
async function overlappingFiles(
  worktreePath: string,
  mainBranch: string,
  conflictingFiles: string[],
): Promise<string[]> {
  const lines = async (args: string[]): Promise<string[]> => {
    const { stdout } = await exec('git', args, {
      cwd: worktreePath,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.split('\n').filter(Boolean);
  };
  try {
    const [ours, theirs] = await Promise.all([
      lines(['diff', '--name-only', '--no-renames', `${mainBranch}...HEAD`, '--']),
      lines([
        'log',
        '--format=',
        '--name-only',
        '--no-renames',
        '--cherry-pick',
        '--right-only',
        `HEAD...${mainBranch}`,
        '--',
      ]),
    ]);
    const conflicting = new Set(conflictingFiles);
    const theirSet = new Set(theirs);
    return ours.filter((file) => theirSet.has(file) && !conflicting.has(file));
  } catch {
    return [];
  }
}

export async function mergeTask(
  projectRoot: string,
  branchName: string,
  squash: boolean,
  message: string | null,
  cleanup: boolean,
  baseBranch?: string,
  worktreePath?: string,
  mergeWorktreePath?: string,
  /** Merge into a checkout with uncommitted changes by setting them aside. */
  allowDirtyTarget = false,
): Promise<MergeResult> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = baseBranch ?? (await detectMainBranch(projectRoot));

    // Safety check: verify the worktree is actually on the expected branch.
    // AI agents sometimes check out a different branch (or detach HEAD),
    // and merging the original branch would silently discard their work.
    // For imported/external worktrees, the caller passes the real path; for
    // managed ones we fall back to the conventional .worktrees/<branch> layout.
    const checkWorktreePath = worktreePath ?? path.join(projectRoot, '.worktrees', branchName);
    if (fs.existsSync(checkWorktreePath)) {
      const actualBranch = await getCurrentBranchName(checkWorktreePath).catch(() => null);
      if (actualBranch === null) {
        throw new Error(
          `The worktree for '${branchName}' has a detached HEAD. ` +
            `Merging would use the stale branch ref and discard work. ` +
            `Please check out '${branchName}' in the worktree first.`,
        );
      }
      if (actualBranch !== branchName) {
        throw new Error(
          `Branch mismatch: the worktree is on '${actualBranch}' but the task expects '${branchName}'. ` +
            `Changes on '${actualBranch}' would be lost. Please check out '${branchName}' in the worktree first, or update the task branch.`,
        );
      }
    }

    const { linesAdded, linesRemoved } = await computeBranchDiffStats(
      projectRoot,
      mainBranch,
      branchName,
    );

    // When the target branch is already checked out in a worktree (e.g. a coordinator
    // worktree on a feature branch), we can't git checkout it in projectRoot — git
    // refuses to check out a branch that's live elsewhere. Merge in that worktree
    // instead; it's already on the right branch.
    const targetWorktree =
      mergeWorktreePath ?? (await getBranchWorktreePath(projectRoot, mainBranch))?.path;
    const mergeRoot = targetWorktree ?? projectRoot;

    // Verify clean working tree in the merge root. The project's Kanban board
    // (KANBAN.md) is edited in place by the app as tasks move, so its unstaged
    // edits do not block a merge: they are set aside and restored around it.
    // Other changes block it unless the caller allows setting them aside too,
    // and the merge leaves the files they touch alone.
    const local = await uncommittedOverlap(mergeRoot, mainBranch, branchName);
    if (local.files.length && !allowDirtyTarget)
      throw new Error(
        'Working tree has uncommitted changes. Please commit or stash them before merging.',
      );
    if (local.overlap.length)
      throw new Error(
        `Uncommitted changes in ${mergeRoot} touch files this merge changes: ` +
          `${fileList(local.overlap)}. Commit or stash them first.`,
      );
    const restoreKanban = await setAsideKanbanEdits(mergeRoot, local.porcelain);
    let restoreLocal = async (_keep?: boolean): Promise<string | undefined> => undefined;
    let branchRestoreFailed = false;
    // Runs once, from catch on failure or else from finally.
    let restored = false;
    const putBack = () => {
      restored = true;
      return restoreLocal(branchRestoreFailed);
    };
    // Same once-only rule for the board: on failure its warning joins the error.
    let boardRestored = false;
    const putBoardBack = () => {
      boardRestored = true;
      return restoreKanban();
    };
    let result: MergeResult;
    let warning: string | undefined;
    try {
      if (local.files.length) restoreLocal = await setAsideLocalChanges(mergeRoot, branchName);
      // Capture the current branch BEFORE any checkout so we can restore it afterward.
      const originalBranch = targetWorktree
        ? null
        : await getCurrentBranchName(projectRoot).catch(() => null);

      if (!targetWorktree) {
        // Need to checkout the target branch in the main repo
        await exec('git', ['checkout', mainBranch], { cwd: projectRoot });
      }

      const restoreBranch = async () => {
        if (originalBranch) {
          try {
            await exec('git', ['checkout', originalBranch], { cwd: projectRoot });
          } catch (e) {
            branchRestoreFailed = true;
            console.warn(`Failed to restore branch '${originalBranch}':`, e);
          }
        }
      };

      const conflictSources = (files: string[]) =>
        conflictSourcesNote(mergeRoot, { mainBranch, branch: branchName }, files);

      if (squash) {
        try {
          await fastForwardBaseToTaskStart(mergeRoot, mainBranch, branchName);
          await exec('git', ['merge', '--squash', '--', branchName], { cwd: mergeRoot });
        } catch (e) {
          const conflicts = await conflictedFiles(mergeRoot);
          await exec('git', ['reset', '--hard', 'HEAD'], { cwd: mergeRoot }).catch((recoverErr) =>
            console.warn('git reset --hard failed during squash recovery:', recoverErr),
          );
          await restoreBranch();
          throw mergeFailure('Squash merge', conflicts, e, await conflictSources(conflicts));
        }
        const msg = message ?? 'Squash merge';
        try {
          await exec('git', ['commit', '-m', msg], { cwd: mergeRoot });
        } catch (e) {
          await exec('git', ['reset', '--hard', 'HEAD'], { cwd: mergeRoot }).catch((recoverErr) =>
            console.warn('git reset --hard failed during commit recovery:', recoverErr),
          );
          await restoreBranch();
          throw new Error(`Commit failed: ${gitErrorText(e)}`);
        }
      } else {
        // A base that moved on since the task branched would get a merge commit;
        // replaying the task onto it first keeps the base's history linear.
        // Without a worktree there is nowhere to rebase, so it merges as before.
        const rebased = fs.existsSync(checkWorktreePath);
        if (rebased) {
          let failed: Awaited<ReturnType<typeof syncWithBaseUnlocked>>;
          try {
            failed = await syncWithBaseUnlocked(checkWorktreePath, mainBranch, 'rebase');
          } catch (e) {
            await restoreBranch();
            throw e;
          }
          if (failed) {
            await restoreBranch();
            throw mergeFailure(
              'Merge',
              failed.conflicts,
              failed.error,
              await conflictSources(failed.conflicts),
            );
          }
        }
        try {
          const ff = rebased ? ['--ff-only'] : [];
          await exec('git', ['merge', ...ff, '--', branchName], { cwd: mergeRoot });
        } catch (e) {
          const conflicts = await conflictedFiles(mergeRoot);
          await exec('git', ['merge', '--abort'], { cwd: mergeRoot }).catch((recoverErr) =>
            console.warn('git merge --abort failed:', recoverErr),
          );
          await restoreBranch();
          throw mergeFailure('Merge', conflicts, e, await conflictSources(conflicts));
        }
      }

      invalidateDiffBaseCache();

      if (cleanup) {
        await removeWorktree(projectRoot, branchName, true, worktreePath);
      }

      await restoreBranch();

      result = { main_branch: mainBranch, lines_added: linesAdded, lines_removed: linesRemoved };
    } catch (e) {
      // The merge error alone would leave the user unaware their changes sit in a stash.
      // A merge can land and a later step (worktree cleanup) still fail.
      const kept = [await putBack(), await putBoardBack()].filter(Boolean).join(' ');
      if (kept) throw new Error(`${e instanceof Error ? e.message : String(e)} ${kept}`);
      throw e;
    } finally {
      // After restoreBranch: the changes go back onto the commit they were made on.
      if (!restored) warning = await putBack();
      const boardWarning = boardRestored ? undefined : await putBoardBack();
      if (boardWarning) warning = warning ? `${warning} ${boardWarning}` : boardWarning;
    }
    return warning ? { ...result, warning } : result;
  });
}

/** `sources` names the base commits behind the conflicts; see `conflictSourcesNote`. */
function mergeFailure(operation: string, conflicts: string[], e: unknown, sources = ''): Error {
  return new Error(
    conflicts.length
      ? `${operation} stopped on conflicts in ${fileList(conflicts)}; nothing was merged.${sources}`
      : `${operation} failed: ${gitErrorText(e)}`,
  );
}

export function pushTask(
  notify: Notify,
  projectRoot: string,
  branchName: string,
  channelId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['push', '--progress', '-u', 'origin', '--', branchName], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const send = (msg: string) => notify(`channel:${channelId}`, msg);

    proc.stdout?.on('data', (chunk: Buffer) => {
      send(chunk.toString('utf8'));
    });

    // Only the last line is used for error messages — cap the buffer to avoid
    // unbounded growth from verbose git push output (progress, LFS, etc.).
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrBuf += text;
      if (stderrBuf.length > STDERR_CAP) {
        stderrBuf = stderrBuf.slice(-STDERR_CAP);
      }
      send(text);
    });

    let settled = false;
    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        const lastLine = stderrBuf.trim().split('\n').pop() || '';
        const fallback = signal
          ? `git push killed by signal ${signal}`
          : `git push exited with code ${code}`;
        reject(new Error(lastLine || fallback));
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`git push failed: ${err.message}`));
    });
  });
}

/**
 * Brings the base branch into the task branch, by rebase or by merge commit.
 * Uncommitted changes are stashed and put back, unless the base changed the
 * same files. A failure is aborted, so the worktree is never left mid-operation.
 */
async function syncWithBase(
  worktreePath: string,
  baseBranch: string | undefined,
  operation: 'rebase' | 'merge',
): Promise<void> {
  const lockKey = await detectRepoLockKey(worktreePath).catch(() => worktreePath);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = baseBranch ?? (await detectMainBranch(worktreePath));
    const failed = await syncWithBaseUnlocked(worktreePath, mainBranch, operation);
    if (!failed) return;
    const label = operation === 'merge' ? 'Merge' : 'Rebase';
    const sources = await conflictSourcesNote(
      worktreePath,
      { mainBranch, branch: 'HEAD' },
      failed.conflicts,
    );
    throw new Error(
      failed.conflicts.length
        ? `${label} stopped on conflicts in ${fileList(failed.conflicts)} and was undone; the branch is unchanged.${sources}`
        : `${label} failed: ${gitErrorText(failed.error)}`,
    );
  });
}

/**
 * `syncWithBase` for callers that already hold the repo's worktree lock.
 * Returns an aborted operation's failure, so each caller can word it.
 */
async function syncWithBaseUnlocked(
  worktreePath: string,
  mainBranch: string,
  operation: 'rebase' | 'merge',
): Promise<{ conflicts: string[]; error: unknown } | null> {
  // Otherwise the autostash would come back with conflict markers in them.
  const { overlap } = await uncommittedOverlap(worktreePath, 'HEAD', mainBranch);
  if (overlap.length)
    throw new Error(
      `Commit or stash your changes to ${fileList(overlap)} first: ${mainBranch} changed them too.`,
    );
  const args =
    operation === 'merge'
      ? ['merge', '--no-edit', '--autostash', mainBranch]
      : ['rebase', '--autostash', mainBranch];
  try {
    await exec('git', args, { cwd: worktreePath });
  } catch (e) {
    const conflicts = await conflictedFiles(worktreePath);
    // --abort also puts the autostash back.
    await exec('git', [operation, '--abort'], { cwd: worktreePath }).catch((recoverErr) =>
      console.warn(`git ${operation} --abort failed:`, recoverErr),
    );
    return { conflicts, error: e };
  }
  invalidateDiffBaseCache();
  return null;
}

/**
 * Points the base branch at its upstream, dropping local commits the
 * upstream lacks; for a base whose local work already landed upstream in
 * another form. Refuses when the base moved since `expectedHead` was read.
 * Uses `reset --keep` in the base's checkout, so uncommitted changes and
 * untracked files survive or the reset stops. Resolves to the old commit.
 */
export async function resetBaseToUpstream(
  projectRoot: string,
  mainBranch: string,
  expectedHead: string,
): Promise<string> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);
  return withWorktreeLock(lockKey, async () => {
    const upstream = await upstreamOf(projectRoot, mainBranch);
    if (!upstream) throw new Error(`${mainBranch} does not track a remote branch.`);
    const { stdout } = await exec('git', ['rev-parse', `refs/heads/${mainBranch}`], {
      cwd: projectRoot,
    });
    const head = stdout.trim();
    if (head !== expectedHead)
      throw new Error(`${mainBranch} changed since it was checked. Review it again first.`);
    const checkout = await getBranchWorktreePath(projectRoot, mainBranch);
    try {
      // `branch -f` itself refuses a branch another worktree is rebasing.
      await (checkout
        ? exec('git', ['reset', '--keep', upstream], { cwd: checkout.path })
        : exec('git', ['branch', '-f', mainBranch, upstream], { cwd: projectRoot }));
    } catch (e) {
      throw new Error(`Could not reset ${mainBranch} to ${upstream}: ${gitErrorText(e)}`);
    }
    invalidateDiffBaseCache();
    return head;
  });
}

export function rebaseTask(worktreePath: string, baseBranch?: string): Promise<void> {
  return syncWithBase(worktreePath, baseBranch, 'rebase');
}

/** Like `rebaseTask`, but keeps the branch history and adds a merge commit. */
export function mergeBaseIntoTask(worktreePath: string, baseBranch?: string): Promise<void> {
  return syncWithBase(worktreePath, baseBranch, 'merge');
}
