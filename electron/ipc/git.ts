import fs from 'fs';
import path from 'path';
import { debug as logDebug } from '../log.js';
import { exec, MAX_BUFFER } from './git-exec.js';
import {
  detectDiffBase,
  detectMainBranch,
  detectMergeBase,
  detectOneWayDiffRange,
  getCurrentBranchName,
  oneWayDiffRange,
  pinHead,
} from './git-diff-base.js';
import { parseWorktreeList, safeRealpath, splitContentLines } from './git-worktree.js';
import type { ChangedFile, CommitInfo, FileDiffResult, WorktreeStatus } from './shared-types.js';

export type { ChangedFile, CommitInfo, FileDiffResult, GitIgnoredEntry } from './shared-types.js';
export {
  blockingStatusLines,
  checkMergeStatus,
  mergeBaseIntoTask,
  mergeTask,
  pushTask,
  rebaseTask,
  resetBaseToUpstream,
  setAsideKanbanEdits,
} from './git-merge.js';
export {
  createWorktree,
  detectRepoRoot,
  getBranchWorktreePath,
  ensureClaudeSandboxFiles,
  ensureSandboxExcludes,
  ensureSymlinkExcludes,
  ensureWorktreeContainerExclude,
  getSymlinkCandidates,
  isValidSymlinkName,
  refreshWorktreeNodeModules,
  removeWorktree,
  worktreePathFor,
} from './git-worktree.js';

// `git diff` against the working tree refreshes stat-only changes by rewriting
// the index, which takes index.lock; an agent committing in the same worktree
// then fails with "index.lock: File exists". --no-optional-locks doesn't cover it.
const NO_INDEX_REFRESH = ['-c', 'diff.autoRefreshIndex=false'];

/** Git's well-known empty tree SHA — used to diff the initial commit against nothing. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Check if a file is binary by looking for null bytes in the first 8KB (same heuristic as git). */
async function isBinaryFile(filePath: string): Promise<boolean> {
  let fd: fs.promises.FileHandle;
  try {
    fd = await fs.promises.open(filePath, 'r');
  } catch {
    return true; // unreadable files are safer treated as binary
  }
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fd.read(buf, 0, 8000, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fd.close();
  }
}

// --- Internal helpers ---

function normalizeStatusPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
}

/** Parse combined `git diff --raw --numstat -z` output into status and numstat maps. */
function parseDiffRawNumstat(output: string): {
  statusMap: Map<string, string>;
  numstatMap: Map<string, [number, number]>;
  previousPathMap: Map<string, string>;
} {
  const statusMap = new Map<string, string>();
  const numstatMap = new Map<string, [number, number]>();
  const previousPathMap = new Map<string, string>();
  const numstatPaths = new Set<string>();

  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;

    if (field.startsWith(':')) {
      const statusLetter = field.split(/\s+/).pop()?.charAt(0) ?? 'M';
      const firstPath = fields[++index] ?? '';
      if (statusLetter === 'R' || statusLetter === 'C') {
        const destinationPath = fields[++index] ?? '';
        if (destinationPath) {
          statusMap.set(destinationPath, statusLetter);
          if (firstPath) previousPathMap.set(destinationPath, firstPath);
        }
      } else if (firstPath) {
        statusMap.set(firstPath, statusLetter);
      }
      continue;
    }

    const firstTab = field.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : field.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;

    let destinationPath = field.slice(secondTab + 1);
    if (!destinationPath) {
      const previousPath = fields[++index] ?? '';
      destinationPath = fields[++index] ?? '';
      if (destinationPath && previousPath && !previousPathMap.has(destinationPath)) {
        previousPathMap.set(destinationPath, previousPath);
      }
    }
    if (!destinationPath) continue;
    numstatPaths.add(destinationPath);

    // Binary files report `-\t-`; they keep their raw status without line counts.
    const added = Number.parseInt(field.slice(0, firstTab), 10);
    const removed = Number.parseInt(field.slice(firstTab + 1, secondTab), 10);
    if (Number.isFinite(added) && Number.isFinite(removed)) {
      numstatMap.set(destinationPath, [added, removed]);
    }
  }

  // Without the index refresh (NO_INDEX_REFRESH), --raw also lists files whose
  // stat changed but content didn't; --numstat compares content and omits them.
  for (const p of statusMap.keys()) {
    if (!numstatPaths.has(p)) {
      statusMap.delete(p);
      previousPathMap.delete(p);
    }
  }

  return { statusMap, numstatMap, previousPathMap };
}

export function changedFilesFromMaps(opts: {
  statusMap: Map<string, string>;
  numstatMap: Map<string, [number, number]>;
  previousPathMap?: Map<string, string>;
  committed: boolean | ((filePath: string) => boolean);
  sort?: boolean;
}): ChangedFile[] {
  const files: ChangedFile[] = [];
  const seen = new Set<string>();
  const committedFor = (filePath: string) =>
    typeof opts.committed === 'function' ? opts.committed(filePath) : opts.committed;

  for (const [p, [added, removed]] of opts.numstatMap) {
    seen.add(p);
    files.push({
      path: p,
      previous_path: opts.previousPathMap?.get(p),
      lines_added: added,
      lines_removed: removed,
      status: opts.statusMap.get(p) ?? 'M',
      committed: committedFor(p),
    });
  }

  for (const [p, status] of opts.statusMap) {
    if (seen.has(p)) continue;
    files.push({
      path: p,
      previous_path: opts.previousPathMap?.get(p),
      lines_added: 0,
      lines_removed: 0,
      status,
      committed: committedFor(p),
    });
  }

  if (opts.sort !== false) files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

interface LineCountEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  lines: number;
}

// The changed-files poll recounts every untracked file each tick; an agent's
// new directory would otherwise be re-read in full every few seconds.
// shortcut: cleared wholesale at the cap — LRU if large worktrees thrash it.
const lineCountCache = new Map<string, LineCountEntry>();
const LINE_COUNT_CACHE_MAX = 5_000;

const NEWLINE = 0x0a;

export async function countReadableTextLines(filePath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size >= MAX_BUFFER) return 0;
    const cached = lineCountCache.get(filePath);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ctimeMs === stat.ctimeMs
    ) {
      return cached.lines;
    }
    // Same count as splitting the decoded text: UTF-8 never encodes another
    // character with a 0x0a byte, so counting raw newlines skips the decode.
    const buf = await fs.promises.readFile(filePath);
    let lines = 0;
    for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, i + 1)) lines++;
    if (buf.length > 0 && buf[buf.length - 1] !== NEWLINE) lines++;
    if (lineCountCache.size >= LINE_COUNT_CACHE_MAX) lineCountCache.clear();
    lineCountCache.set(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      lines,
    });
    return lines;
  } catch {
    return 0;
  }
}

// --- IPC command functions ---

export async function getMainBranch(projectRoot: string): Promise<string> {
  return detectMainBranch(projectRoot);
}

export async function getCurrentBranch(projectRoot: string): Promise<string> {
  return getCurrentBranchName(projectRoot);
}

export async function checkoutBranch(projectRoot: string, branchName: string): Promise<void> {
  await exec('git', ['checkout', branchName], { cwd: projectRoot });
}

export async function getBranches(projectRoot: string): Promise<string[]> {
  const { stdout } = await exec('git', ['branch', '--list', '--format=%(refname:short)'], {
    cwd: projectRoot,
  });
  return stdout
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
}

export async function getChangedFiles(
  worktreePath: string,
  baseBranch?: string,
): Promise<ChangedFile[]> {
  const headHash = await pinHead(worktreePath);

  // Use the picked merge-base as the stats anchor so the file list matches
  // the all-changes diff body, including tracked local edits on top of HEAD.
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));

  let finalDiffStr = '';
  try {
    const { stdout } = await exec(
      'git',
      [...NO_INDEX_REFRESH, 'diff', '--raw', '--numstat', '-z', diffBase.sha],
      {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      },
    );
    finalDiffStr = stdout;
  } catch {
    /* empty */
  }

  const {
    statusMap: finalStatusMap,
    numstatMap: finalNumstatMap,
    previousPathMap: finalPreviousPathMap,
  } = parseDiffRawNumstat(finalDiffStr);

  // git diff --raw --numstat <headHash> — tracked uncommitted changes (HEAD vs working tree).
  // NO_INDEX_REFRESH keeps it from taking index.lock while an agent commits.
  // git ls-files --others --exclude-standard — untracked files (no index lock needed).
  // Both commands run in parallel since they are independent.
  const [uncommittedResult, untrackedResult] = await Promise.all([
    exec('git', [...NO_INDEX_REFRESH, 'diff', '--raw', '--numstat', '-z', headHash], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    }).catch(() => ({ stdout: '' })),
    exec('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    }).catch(() => ({ stdout: '' })),
  ]);

  const { statusMap: uncommittedStatusMap, numstatMap: uncommittedNumstatMap } =
    parseDiffRawNumstat(uncommittedResult.stdout);

  const untrackedPaths = new Set<string>();
  for (const line of untrackedResult.stdout.split('\n')) {
    const p = normalizeStatusPath(line);
    if (p) untrackedPaths.add(p);
  }

  const isCommitted = (p: string) =>
    !uncommittedNumstatMap.has(p) && !uncommittedStatusMap.has(p) && !untrackedPaths.has(p);

  const files = changedFilesFromMaps({
    statusMap: finalStatusMap,
    numstatMap: finalNumstatMap,
    previousPathMap: finalPreviousPathMap,
    committed: isCommitted,
    sort: false,
  });
  const seen = new Set(files.map((file) => file.path));

  // Untracked (new) files: count all lines as added
  for (const p of untrackedPaths) {
    if (seen.has(p)) continue;
    const added = await countReadableTextLines(path.join(worktreePath, p));
    files.push({ path: p, lines_added: added, lines_removed: 0, status: '?', committed: false });
  }

  files.sort((a, b) => {
    if (a.committed !== b.committed) return a.committed ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return files;
}

async function buildUntrackedPseudoDiffs(worktreePath: string, pathPrefix = ''): Promise<string[]> {
  const parts: string[] = [];
  let stdout = '';
  try {
    const result = await exec('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    stdout = result.stdout;
  } catch {
    return parts;
  }

  for (const line of stdout.split('\n')) {
    const filePath = normalizeStatusPath(line);
    if (!filePath) continue;
    const fullPath = path.join(worktreePath, filePath);
    const shownPath = pathPrefix + filePath;
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile() || stat.size >= MAX_BUFFER) continue;
      if (await isBinaryFile(fullPath)) {
        parts.push(
          `diff --git a/${shownPath} b/${shownPath}\nnew file mode 100644\nBinary files /dev/null and b/${shownPath} differ\n`,
        );
        continue;
      }
      const content = await fs.promises.readFile(fullPath, 'utf8');
      const lines = splitContentLines(content);
      const pseudoLines: string[] = [];
      pseudoLines.push(`diff --git a/${shownPath} b/${shownPath}`);
      pseudoLines.push('new file mode 100644');
      pseudoLines.push('--- /dev/null');
      pseudoLines.push(`+++ b/${shownPath}`);
      pseudoLines.push(`@@ -0,0 +1,${lines.length} @@`);
      for (const line of lines) {
        pseudoLines.push(`+${line}`);
      }
      parts.push(pseudoLines.join('\n') + '\n');
    } catch {
      /* skip unreadable files */
    }
  }
  return parts;
}

async function getUntrackedChangedFiles(
  worktreePath: string,
  seen: Set<string> = new Set(),
): Promise<ChangedFile[]> {
  let stdout = '';
  try {
    const result = await exec('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    stdout = result.stdout;
  } catch {
    return [];
  }

  const files: ChangedFile[] = [];
  for (const line of stdout.split('\n')) {
    const p = normalizeStatusPath(line);
    if (!p || seen.has(p)) continue;
    seen.add(p);

    const added = await countReadableTextLines(path.join(worktreePath, p));
    files.push({ path: p, lines_added: added, lines_removed: 0, status: '?', committed: false });
  }
  return files;
}

export async function getDiffBaseSha(worktreePath: string, baseBranch?: string): Promise<string> {
  const headHash = await pinHead(worktreePath);
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));
  return diffBase.sha;
}

/** `git diff` options that show paths under `pathPrefix`, for a repo nested in a task's worktree. */
function diffPathPrefixArgs(pathPrefix: string): string[] {
  return pathPrefix ? [`--src-prefix=a/${pathPrefix}`, `--dst-prefix=b/${pathPrefix}`] : [];
}

export async function getAllFileDiffs(
  worktreePath: string,
  baseBranch?: string,
  pathPrefix = '',
): Promise<string> {
  const headHash = await pinHead(worktreePath);

  // For working-tree output, use the merge-base SHA as a single diff start
  // point. `git diff base...` would stop at HEAD and hide tracked local edits.
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));

  let combinedDiff = '';
  try {
    const { stdout } = await exec(
      'git',
      [...NO_INDEX_REFRESH, 'diff', '-U3', ...diffPathPrefixArgs(pathPrefix), diffBase.sha],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    combinedDiff = stdout;
  } catch {
    /* empty */
  }

  const untrackedParts = await buildUntrackedPseudoDiffs(worktreePath, pathPrefix);
  const parts = [combinedDiff, untrackedParts.join('')].filter((p) => p.length > 0);
  return parts.join('\n');
}

export async function getUncommittedFileDiffs(
  worktreePath: string,
  pathPrefix = '',
): Promise<string> {
  const headHash = await pinHead(worktreePath);

  // Diff against HEAD captures only tracked uncommitted changes (working tree
  // vs HEAD), excluding committed work. NO_INDEX_REFRESH keeps it from taking
  // index.lock while an agent commits.
  let combinedDiff = '';
  try {
    const { stdout } = await exec(
      'git',
      [...NO_INDEX_REFRESH, 'diff', '-U3', ...diffPathPrefixArgs(pathPrefix), headHash],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    combinedDiff = stdout;
  } catch {
    /* empty */
  }

  const untrackedParts = await buildUntrackedPseudoDiffs(worktreePath, pathPrefix);
  const parts = [combinedDiff, untrackedParts.join('')].filter((p) => p.length > 0);
  return parts.join('\n');
}

export async function getUncommittedChangedFiles(worktreePath: string): Promise<ChangedFile[]> {
  const headHash = await pinHead(worktreePath);
  let diffStr = '';
  try {
    const { stdout } = await exec(
      'git',
      [...NO_INDEX_REFRESH, 'diff', '--raw', '--numstat', '-z', headHash],
      {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      },
    );
    diffStr = stdout;
  } catch {
    /* empty */
  }

  const { statusMap, numstatMap, previousPathMap } = parseDiffRawNumstat(diffStr);
  const files = changedFilesFromMaps({
    statusMap,
    numstatMap,
    previousPathMap,
    committed: false,
    sort: false,
  });
  const seen = new Set(files.map((file) => file.path));

  files.push(...(await getUntrackedChangedFiles(worktreePath, seen)));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function getAllFileDiffsFromBranch(
  projectRoot: string,
  branchName: string,
  baseBranch?: string,
): Promise<string> {
  const diffRange = await detectOneWayDiffRange(projectRoot, branchName, baseBranch);
  try {
    const { stdout } = await exec('git', ['diff', '-U3', diffRange], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return '';
  }
}

export async function getFileDiff(
  worktreePath: string,
  filePath: string,
  baseBranch?: string,
): Promise<FileDiffResult> {
  const headHash = await pinHead(worktreePath);
  const diffBase = await detectDiffBase(worktreePath, headHash, baseBranch).catch(() => ({
    sha: headHash,
    ref: headHash,
  }));
  const base = diffBase.sha;

  // Old content from merge-base (what existed when the branch was created)
  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${base}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    /* file didn't exist at merge-base — new file */
  }

  // New content: prefer committed content from HEAD, fall back to disk
  let newContent = '';
  let committedContent = '';
  let fileExistsOnDisk = false;
  let fileContentReadable = false;

  // Try reading committed content from git
  try {
    const { stdout } = await exec('git', ['show', `${headHash}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    committedContent = stdout;
  } catch {
    /* file not in HEAD — untracked or new */
  }

  // Read disk content
  const fullPath = path.join(worktreePath, filePath);
  let diskContent = '';
  try {
    const stat = await fs.promises.stat(fullPath);
    if (stat.isFile()) {
      fileExistsOnDisk = true;
      if (stat.size < MAX_BUFFER) {
        diskContent = await fs.promises.readFile(fullPath, 'utf8');
        fileContentReadable = true;
      }
    }
  } catch {
    /* file doesn't exist — deleted file */
  }

  // Detect uncommitted deletion: file tracked in HEAD but deleted locally
  const isUncommittedDeletion = !fileExistsOnDisk && committedContent !== '';

  // Select newContent based on file state
  const hasUncommittedChanges =
    committedContent && fileExistsOnDisk && fileContentReadable && diskContent !== committedContent;
  if (isUncommittedDeletion) {
    newContent = '';
    // File added in branch but deleted locally — show committed content as "old" side
    if (!oldContent && committedContent) {
      oldContent = committedContent;
    }
  } else if (hasUncommittedChanges) {
    newContent = diskContent;
  } else if (committedContent) {
    newContent = committedContent;
  } else {
    newContent = diskContent;
  }

  // Generate diff between merge-base and HEAD for committed files
  let diff = '';
  try {
    const diffRange = oneWayDiffRange(diffBase, headHash);
    const { stdout } = await exec('git', ['diff', diffRange, '--', filePath], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    if (stdout.trim()) diff = stdout;
  } catch {
    /* empty */
  }

  // Untracked/uncommitted file with no committed diff — build pseudo-diff from disk content
  // Only when content was actually readable (skip for files exceeding MAX_BUFFER)
  if (!diff && fileExistsOnDisk && !oldContent && fileContentReadable) {
    if (await isBinaryFile(fullPath)) {
      diff = `Binary files /dev/null and b/${filePath} differ`;
    } else {
      const lines = splitContentLines(newContent);
      const pseudoLines: string[] = [];
      pseudoLines.push(`--- /dev/null`);
      pseudoLines.push(`+++ b/${filePath}`);
      pseudoLines.push(`@@ -0,0 +1,${lines.length} @@`);
      for (const line of lines) {
        pseudoLines.push(`+${line}`);
      }
      diff = pseudoLines.join('\n') + '\n';
    }
  }

  // Uncommitted deletion with no committed diff — build deletion pseudo-diff
  if (!diff && isUncommittedDeletion && oldContent) {
    const lines = splitContentLines(oldContent);
    const pseudoLines: string[] = [];
    pseudoLines.push(`--- a/${filePath}`);
    pseudoLines.push(`+++ /dev/null`);
    pseudoLines.push(`@@ -1,${lines.length} +0,0 @@`);
    for (const line of lines) {
      pseudoLines.push(`-${line}`);
    }
    diff = pseudoLines.join('\n') + '\n';
  }

  return { diff, oldContent, newContent };
}

const UNREADABLE_WORKTREE_STATUS: WorktreeStatus = {
  has_committed_changes: false,
  has_uncommitted_changes: false,
  current_branch: null,
  base_branch: null,
};

/** Parse `git status --porcelain=v2 --branch` output. */
export function parseStatusV2(out: string): {
  currentBranch: string | null;
  headSha: string | null;
  hasUncommittedChanges: boolean;
} {
  let currentBranch: string | null = null;
  let headSha: string | null = null;
  let hasUncommittedChanges = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      currentBranch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length);
      // An unborn branch has no commit yet.
      headSha = oid === '(initial)' ? null : oid;
    } else if (line.length > 0 && !line.startsWith('#')) {
      hasUncommittedChanges = true;
    }
  }
  return { currentBranch, headSha, hasUncommittedChanges };
}

export async function getWorktreeStatus(
  worktreePath: string,
  baseBranch?: string,
): Promise<WorktreeStatus> {
  if (!fs.existsSync(worktreePath)) {
    return UNREADABLE_WORKTREE_STATUS;
  }
  let statusOut: string;
  try {
    // Polled every few seconds while agents run git in the same worktree:
    // skip status's opportunistic index refresh so it never takes index.lock
    // (agents would see "index.lock: File exists") or rewrites the index.
    // `--branch` also reports HEAD's branch and sha, saving two git spawns per
    // poll; `--no-ahead-behind` skips the upstream count this doesn't use.
    ({ stdout: statusOut } = await exec(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--no-ahead-behind'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    ));
  } catch {
    // Worktree removed between existsSync and exec (race condition)
    return UNREADABLE_WORKTREE_STATUS;
  }
  const { currentBranch, headSha, hasUncommittedChanges } = parseStatusV2(statusOut);

  // Resolved base branch name, so the frontend can tell "agent switched to a
  // feature branch" (adoptable) apart from "agent is sitting on main" (not).
  const resolvedBaseBranch = baseBranch ?? (await detectMainBranch(worktreePath).catch(() => null));

  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', resolvedBaseBranch ?? undefined);
  let hasCommittedChanges = false;
  try {
    // One commit is enough to answer "any?"; don't list the whole branch.
    const { stdout: logOut } = await exec(
      'git',
      ['log', '-1', '--format=%H', `${mergeBase}..HEAD`],
      {
        cwd: worktreePath,
      },
    );
    hasCommittedChanges = logOut.trim().length > 0;
  } catch {
    /* ignore */
  }

  return {
    has_committed_changes: hasCommittedChanges,
    has_uncommitted_changes: hasUncommittedChanges,
    current_branch: currentBranch,
    base_branch: resolvedBaseBranch,
    head_sha: headSha,
    ...(await countChangedLines(worktreePath, mergeBase)),
  };
}

/** Parse `git diff --shortstat` output, e.g. " 2 files changed, 5 insertions(+), 1 deletion(-)". */
function parseShortstat(out: string): { lines_added: number; lines_removed: number } {
  const added = /(\d+) insertions?\(\+\)/.exec(out);
  const removed = /(\d+) deletions?\(-\)/.exec(out);
  return {
    lines_added: added ? Number(added[1]) : 0,
    lines_removed: removed ? Number(removed[1]) : 0,
  };
}

/** Lines the branch's commits change since the merge base; uncommitted work counts once committed. */
async function countChangedLines(
  worktreePath: string,
  mergeBase: string,
): Promise<{ lines_added?: number; lines_removed?: number }> {
  try {
    // Tree to tree: never reads the working tree or the index an agent may be locking.
    // -M: a renamed file counts its edits, not its whole content twice.
    const { stdout } = await exec(
      'git',
      ['diff-tree', '-r', '-M', '--shortstat', mergeBase, 'HEAD'],
      {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      },
    );
    return parseShortstat(stdout);
  } catch {
    // Unknown counts stay absent rather than claiming zero.
    return {};
  }
}

export async function listImportableWorktrees(projectRoot: string): Promise<
  Array<{
    path: string;
    branch_name: string;
    has_committed_changes: boolean;
    has_uncommitted_changes: boolean;
  }>
> {
  if (!(await isGitRepo(projectRoot))) return [];

  const projectRealPath = safeRealpath(projectRoot);
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectRoot,
    maxBuffer: MAX_BUFFER,
  });

  const candidates = parseWorktreeList(stdout).filter((entry) => {
    if (!entry.path || !entry.branchName || entry.detached) return false;
    return safeRealpath(entry.path) !== projectRealPath;
  });

  const results = await Promise.all(
    candidates.map(async (entry) => {
      try {
        const status = await getWorktreeStatus(entry.path);
        return {
          path: entry.path,
          branch_name: entry.branchName ?? '',
          has_committed_changes: status.has_committed_changes,
          has_uncommitted_changes: status.has_uncommitted_changes,
        };
      } catch {
        return null;
      }
    }),
  );

  const filtered = results.filter(
    (
      entry,
    ): entry is {
      path: string;
      branch_name: string;
      has_committed_changes: boolean;
      has_uncommitted_changes: boolean;
    } => entry !== null,
  );

  filtered.sort(
    (a, b) => a.branch_name.localeCompare(b.branch_name) || a.path.localeCompare(b.path),
  );
  return filtered;
}

/** Stage all changes and commit in a worktree. */
export async function commitAll(worktreePath: string, message: string): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: worktreePath });
  await exec('git', ['commit', '-m', message], { cwd: worktreePath });
}

/** Discard all uncommitted changes in a worktree (keeps committed work). */
export async function discardUncommitted(worktreePath: string): Promise<void> {
  await exec('git', ['checkout', '.'], { cwd: worktreePath });
  await exec('git', ['clean', '-fd'], { cwd: worktreePath });
}

export async function getBranchLog(worktreePath: string, baseBranch?: string): Promise<string> {
  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', baseBranch);
  try {
    const { stdout } = await exec('git', ['log', `${mergeBase}..HEAD`, '--pretty=format:- %h %s'], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return '';
  }
}

export async function getChangedFilesFromBranch(
  projectRoot: string,
  branchName: string,
  baseBranch?: string,
): Promise<ChangedFile[]> {
  const diffRange = await detectOneWayDiffRange(projectRoot, branchName, baseBranch);

  let diffStr = '';
  try {
    const { stdout } = await exec('git', ['diff', '--raw', '--numstat', '-z', diffRange], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    diffStr = stdout;
  } catch {
    return [];
  }

  const { statusMap, numstatMap, previousPathMap } = parseDiffRawNumstat(diffStr);

  return changedFilesFromMaps({ statusMap, numstatMap, previousPathMap, committed: true });
}

export async function getFileDiffFromBranch(
  projectRoot: string,
  branchName: string,
  filePath: string,
  baseBranch?: string,
): Promise<FileDiffResult> {
  const diffBase = await detectDiffBase(projectRoot, branchName, baseBranch);
  const base = diffBase.sha;
  const diffRange = oneWayDiffRange(diffBase, branchName);

  let diff = '';
  try {
    const { stdout } = await exec('git', ['diff', diffRange, '--', filePath], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    diff = stdout;
  } catch {
    /* empty */
  }

  let oldContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${base}:${filePath}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    oldContent = stdout;
  } catch {
    /* file didn't exist at merge base */
  }

  let newContent = '';
  try {
    const { stdout } = await exec('git', ['show', `${branchName}:${filePath}`], {
      cwd: projectRoot,
      maxBuffer: MAX_BUFFER,
    });
    newContent = stdout;
  } catch {
    /* file doesn't exist on branch */
  }

  return { diff, oldContent, newContent };
}

/** Check whether a directory is the root of a git repository. */
export async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: dirPath });
    const toplevel = await fs.promises.realpath(stdout.trim());
    const resolved = await fs.promises.realpath(dirPath);
    return toplevel === resolved;
  } catch {
    return false;
  }
}

// --- Per-commit operations ---

export async function getBranchCommits(
  worktreePath: string,
  baseBranch?: string,
  recentFallback?: number,
): Promise<CommitInfo[]> {
  if (!fs.existsSync(worktreePath)) return [];
  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', baseBranch);
  try {
    const { stdout } = await exec(
      'git',
      ['log', `${mergeBase}..HEAD`, '--pretty=format:%H%x00%s', '--reverse'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    if (!stdout.trim()) {
      // No branch-specific commits (e.g. direct mode on main). If a recent
      // fallback count was requested, list the last N commits from HEAD so
      // the user can still navigate commit history.
      if (recentFallback && recentFallback > 0) {
        return getRecentCommits(worktreePath, recentFallback);
      }
      return [];
    }
    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const sep = line.indexOf('\0');
        return {
          hash: sep >= 0 ? line.slice(0, sep) : line,
          message: sep >= 0 ? line.slice(sep + 1) : '',
        };
      });
  } catch (err) {
    logDebug('git', `getBranchCommits failed for ${worktreePath}: ${err}`);
    return [];
  }
}

/** Branch commits, oldest first, with their full messages — for squash commit defaults. */
export async function getBranchCommitMessages(
  worktreePath: string,
  baseBranch?: string,
): Promise<CommitInfo[]> {
  if (!fs.existsSync(worktreePath)) return [];
  const mergeBase = await detectMergeBase(worktreePath, 'HEAD', baseBranch);
  try {
    // Record separator between commits: bodies can contain newlines.
    const { stdout } = await exec(
      'git',
      ['log', `${mergeBase}..HEAD`, '--pretty=format:%H%x00%s%x00%b%x1e', '--reverse'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    return stdout
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter((record) => record.trim())
      .map((record) => {
        const [hash = '', message = '', body = ''] = record.split('\0');
        return { hash, message, body: body.trim() };
      });
  } catch (err) {
    logDebug('git', `getBranchCommitMessages failed for ${worktreePath}: ${err}`);
    return [];
  }
}

async function getRecentCommits(worktreePath: string, count: number): Promise<CommitInfo[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['log', `--max-count=${count}`, '--pretty=format:%H%x00%s', '--reverse'],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const sep = line.indexOf('\0');
        return {
          hash: sep >= 0 ? line.slice(0, sep) : line,
          message: sep >= 0 ? line.slice(sep + 1) : '',
        };
      });
  } catch (err) {
    logDebug('git', `getRecentCommits failed for ${worktreePath}: ${err}`);
    return [];
  }
}

export async function getCommitChangedFiles(
  worktreePath: string,
  commitHash: string,
): Promise<ChangedFile[]> {
  let diffStr = '';
  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--raw', '--numstat', '-z', `${commitHash}^..${commitHash}`],
      { cwd: worktreePath, maxBuffer: MAX_BUFFER },
    );
    diffStr = stdout;
  } catch {
    // Likely the initial commit (no parent). Diff against the empty tree.
    try {
      const { stdout } = await exec(
        'git',
        ['diff', '--raw', '--numstat', '-z', `${EMPTY_TREE}..${commitHash}`],
        { cwd: worktreePath, maxBuffer: MAX_BUFFER },
      );
      diffStr = stdout;
    } catch (err) {
      logDebug('git', `getCommitChangedFiles failed for ${commitHash} in ${worktreePath}: ${err}`);
      return [];
    }
  }

  const { statusMap, numstatMap, previousPathMap } = parseDiffRawNumstat(diffStr);

  return changedFilesFromMaps({ statusMap, numstatMap, previousPathMap, committed: true });
}

export async function getCommitDiffs(worktreePath: string, commitHash: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['diff', '-U3', `${commitHash}^..${commitHash}`], {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    // Likely the initial commit (no parent). Diff against the empty tree.
    try {
      const { stdout } = await exec('git', ['diff', '-U3', `${EMPTY_TREE}..${commitHash}`], {
        cwd: worktreePath,
        maxBuffer: MAX_BUFFER,
      });
      return stdout;
    } catch (err) {
      logDebug('git', `getCommitDiffs failed for ${commitHash} in ${worktreePath}: ${err}`);
      return '';
    }
  }
}
