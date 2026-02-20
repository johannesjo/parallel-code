import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";

const exec = promisify(execFile);

// --- TTL Caches ---

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const mainBranchCache = new Map<string, CacheEntry>();
const mergeBaseCache = new Map<string, CacheEntry>();
const MAIN_BRANCH_TTL = 60_000; // 60s
const MERGE_BASE_TTL = 30_000; // 30s

function invalidateMergeBaseCache(): void {
  mergeBaseCache.clear();
}

function cacheKey(p: string): string {
  return p.replace(/\/+$/, "");
}

// --- Worktree lock serialization ---

const worktreeLocks = new Map<string, Promise<void>>();

function withWorktreeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = worktreeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  worktreeLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

// --- Symlink candidates ---

const SYMLINK_CANDIDATES = [
  ".claude",
  ".cursor",
  ".aider",
  ".copilot",
  ".codeium",
  ".continue",
  ".windsurf",
  "node_modules",
];

// --- Internal helpers ---

async function detectMainBranch(repoRoot: string): Promise<string> {
  const key = cacheKey(repoRoot);
  const cached = mainBranchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const result = await detectMainBranchUncached(repoRoot);
  mainBranchCache.set(key, { value: result, expiresAt: Date.now() + MAIN_BRANCH_TTL });
  return result;
}

async function detectMainBranchUncached(repoRoot: string): Promise<string> {
  // Try remote HEAD reference first
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repoRoot });
    const refname = stdout.trim();
    const prefix = "refs/remotes/origin/";
    if (refname.startsWith(prefix)) return refname.slice(prefix.length);
  } catch { /* ignore */ }

  // Check if 'main' exists
  try {
    await exec("git", ["rev-parse", "--verify", "main"], { cwd: repoRoot });
    return "main";
  } catch { /* ignore */ }

  // Fallback to 'master'
  try {
    await exec("git", ["rev-parse", "--verify", "master"], { cwd: repoRoot });
    return "master";
  } catch { /* ignore */ }

  throw new Error("Could not find main or master branch");
}

async function getCurrentBranchName(repoRoot: string): Promise<string> {
  const { stdout } = await exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

async function detectMergeBase(repoRoot: string): Promise<string> {
  const key = cacheKey(repoRoot);
  const cached = mergeBaseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const mainBranch = await detectMainBranch(repoRoot);
  let result: string;
  try {
    const { stdout } = await exec("git", ["merge-base", mainBranch, "HEAD"], { cwd: repoRoot });
    const hash = stdout.trim();
    result = hash || mainBranch;
  } catch {
    result = mainBranch;
  }

  mergeBaseCache.set(key, { value: result, expiresAt: Date.now() + MERGE_BASE_TTL });
  return result;
}

async function detectRepoLockKey(p: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "--git-common-dir"], { cwd: p });
  const commonDir = stdout.trim();
  const commonPath = path.isAbsolute(commonDir) ? commonDir : path.join(p, commonDir);
  try {
    return fs.realpathSync(commonPath);
  } catch {
    return commonPath;
  }
}

function normalizeStatusPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Handle rename/copy "old -> new"
  const destination = trimmed.split(" -> ").pop()?.trim() ?? trimmed;
  return destination.replace(/^"|"$/g, "");
}

function parseConflictPath(line: string): string | null {
  const trimmed = line.trim();

  // Format: "CONFLICT (...): Merge conflict in <path>"
  const mergeConflictIdx = trimmed.indexOf("Merge conflict in ");
  if (mergeConflictIdx !== -1) {
    const p = trimmed.slice(mergeConflictIdx + "Merge conflict in ".length).trim();
    return p || null;
  }

  if (!trimmed.startsWith("CONFLICT")) return null;

  // Format: "CONFLICT (...): path <marker>"
  const parenClose = trimmed.indexOf("): ");
  if (parenClose === -1) return null;
  const afterParen = trimmed.slice(parenClose + 3);

  const markers = [" deleted in ", " modified in ", " added in ", " renamed in ", " changed in "];
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
  branchName: string
): Promise<{ linesAdded: number; linesRemoved: number }> {
  const { stdout } = await exec("git", ["diff", "--numstat", `${mainBranch}..${branchName}`], { cwd: projectRoot });
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    linesAdded += parseInt(parts[0], 10) || 0;
    linesRemoved += parseInt(parts[1], 10) || 0;
  }
  return { linesAdded, linesRemoved };
}

// --- Public functions (used by tasks.ts and register.ts) ---

export async function createWorktree(
  repoRoot: string,
  branchName: string,
  symlinkDirs: string[]
): Promise<{ path: string; branch: string }> {
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;

  // Try -b first (new branch), fall back to existing branch
  try {
    await exec("git", ["worktree", "add", "-b", branchName, worktreePath], { cwd: repoRoot });
  } catch {
    await exec("git", ["worktree", "add", worktreePath, branchName], { cwd: repoRoot });
  }

  // Symlink selected directories
  for (const name of symlinkDirs) {
    const source = path.join(repoRoot, name);
    const target = path.join(worktreePath, name);
    try {
      if (fs.statSync(source).isDirectory() && !fs.existsSync(target)) {
        fs.symlinkSync(source, target);
      }
    } catch { /* ignore */ }
  }

  return { path: worktreePath, branch: branchName };
}

export async function removeWorktree(
  repoRoot: string,
  branchName: string,
  deleteBranch: boolean
): Promise<void> {
  const worktreePath = `${repoRoot}/.worktrees/${branchName}`;

  if (!fs.existsSync(repoRoot)) return;

  if (fs.existsSync(worktreePath)) {
    try {
      await exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
    } catch {
      // Fallback: direct directory removal
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Prune stale worktree entries
  try {
    await exec("git", ["worktree", "prune"], { cwd: repoRoot });
  } catch { /* ignore */ }

  if (deleteBranch) {
    try {
      await exec("git", ["branch", "-D", "--", branchName], { cwd: repoRoot });
    } catch (e: unknown) {
      const msg = String(e);
      if (!msg.toLowerCase().includes("not found")) throw e;
    }
  }
}

// --- IPC command functions ---

export async function getGitIgnoredDirs(projectRoot: string): Promise<string[]> {
  const results: string[] = [];
  for (const name of SYMLINK_CANDIDATES) {
    const dirPath = path.join(projectRoot, name);
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
    } catch { continue; }
    try {
      await exec("git", ["check-ignore", "-q", name], { cwd: projectRoot });
      results.push(name);
    } catch { /* not ignored */ }
  }
  return results;
}

export async function getMainBranch(projectRoot: string): Promise<string> {
  return detectMainBranch(projectRoot);
}

export async function getCurrentBranch(projectRoot: string): Promise<string> {
  return getCurrentBranchName(projectRoot);
}

export async function getChangedFiles(
  worktreePath: string
): Promise<Array<{ path: string; lines_added: number; lines_removed: number; status: string; committed: boolean }>> {
  const base = await detectMergeBase(worktreePath).catch(() => "HEAD");

  // git diff --raw --numstat <base>
  let diffStr = "";
  try {
    const { stdout } = await exec("git", ["diff", "--raw", "--numstat", base], { cwd: worktreePath });
    diffStr = stdout;
  } catch { /* empty */ }

  const statusMap = new Map<string, string>();
  const numstatMap = new Map<string, [number, number]>();

  for (const line of diffStr.split("\n")) {
    if (line.startsWith(":")) {
      // --raw format
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const statusLetter = parts[0].split(/\s+/).pop()?.charAt(0) ?? "M";
        const rawPath = parts[parts.length - 1];
        const p = normalizeStatusPath(rawPath);
        if (p) statusMap.set(p, statusLetter);
      }
      continue;
    }
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const added = parseInt(parts[0], 10);
      const removed = parseInt(parts[1], 10);
      if (!isNaN(added) && !isNaN(removed)) {
        const rawPath = parts[parts.length - 1];
        const p = normalizeStatusPath(rawPath);
        if (p) numstatMap.set(p, [added, removed]);
      }
    }
  }

  // git status --porcelain for uncommitted paths
  let statusStr = "";
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: worktreePath });
    statusStr = stdout;
  } catch { /* empty */ }

  const uncommittedPaths = new Set<string>();
  for (const line of statusStr.split("\n")) {
    if (line.length < 3) continue;
    const p = normalizeStatusPath(line.slice(3));
    if (!p) continue;
    if (line.startsWith("??")) {
      if (!statusMap.has(p)) statusMap.set(p, "?");
    }
    uncommittedPaths.add(p);
  }

  const files: Array<{ path: string; lines_added: number; lines_removed: number; status: string; committed: boolean }> = [];
  const seen = new Set<string>();

  for (const [p, [added, removed]] of numstatMap) {
    const status = statusMap.get(p) ?? "M";
    const committed = !uncommittedPaths.has(p);
    seen.add(p);
    files.push({ path: p, lines_added: added, lines_removed: removed, status, committed });
  }

  // Files from statusMap not in numstat (untracked)
  for (const [p, status] of statusMap) {
    if (seen.has(p)) continue;
    const fullPath = path.join(worktreePath, p);
    let added = 0;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        const content = fs.readFileSync(fullPath, "utf8");
        added = content.split("\n").length;
      }
    } catch { /* ignore */ }
    files.push({ path: p, lines_added: added, lines_removed: 0, status, committed: !uncommittedPaths.has(p) });
  }

  files.sort((a, b) => {
    if (a.committed !== b.committed) return a.committed ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return files;
}

export async function getFileDiff(worktreePath: string, filePath: string): Promise<string> {
  const base = await detectMergeBase(worktreePath).catch(() => "HEAD");

  try {
    const { stdout } = await exec("git", ["diff", base, "--", filePath], { cwd: worktreePath });
    if (stdout.trim()) return stdout;
  } catch { /* empty */ }

  // Untracked file — format as all-additions
  const fullPath = path.join(worktreePath, filePath);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content.split("\n");
    let pseudo = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
    for (const line of lines) {
      pseudo += `+${line}\n`;
    }
    return pseudo;
  }

  return "";
}

export async function getWorktreeStatus(
  worktreePath: string
): Promise<{ has_committed_changes: boolean; has_uncommitted_changes: boolean }> {
  const { stdout: statusOut } = await exec("git", ["status", "--porcelain"], { cwd: worktreePath });
  const hasUncommittedChanges = statusOut.trim().length > 0;

  const mainBranch = await detectMainBranch(worktreePath).catch(() => "HEAD");
  let hasCommittedChanges = false;
  try {
    const { stdout: logOut } = await exec("git", ["log", `${mainBranch}..HEAD`, "--oneline"], { cwd: worktreePath });
    hasCommittedChanges = logOut.trim().length > 0;
  } catch { /* ignore */ }

  return { has_committed_changes: hasCommittedChanges, has_uncommitted_changes: hasUncommittedChanges };
}

export async function checkMergeStatus(
  worktreePath: string
): Promise<{ main_ahead_count: number; conflicting_files: string[] }> {
  const mainBranch = await detectMainBranch(worktreePath);

  let mainAheadCount = 0;
  try {
    const { stdout } = await exec("git", ["rev-list", "--count", `HEAD..${mainBranch}`], { cwd: worktreePath });
    mainAheadCount = parseInt(stdout.trim(), 10) || 0;
  } catch { /* ignore */ }

  if (mainAheadCount === 0) return { main_ahead_count: 0, conflicting_files: [] };

  const conflictingFiles: string[] = [];
  try {
    await exec("git", ["merge-tree", "--write-tree", "HEAD", mainBranch], { cwd: worktreePath });
  } catch (e: unknown) {
    // merge-tree outputs conflict info on failure
    const output = String(e);
    for (const line of output.split("\n")) {
      const p = parseConflictPath(line);
      if (p) conflictingFiles.push(p);
    }
  }

  return { main_ahead_count: mainAheadCount, conflicting_files: conflictingFiles };
}

export async function mergeTask(
  projectRoot: string,
  branchName: string,
  squash: boolean,
  message: string | null,
  cleanup: boolean
): Promise<{ main_branch: string; lines_added: number; lines_removed: number }> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = await detectMainBranch(projectRoot);
    const { linesAdded, linesRemoved } = await computeBranchDiffStats(projectRoot, mainBranch, branchName);

    // Verify clean working tree
    const { stdout: statusOut } = await exec("git", ["status", "--porcelain"], { cwd: projectRoot });
    if (statusOut.trim()) throw new Error("Project root has uncommitted changes. Please commit or stash them before merging.");

    const originalBranch = await getCurrentBranchName(projectRoot).catch(() => null);

    // Checkout main
    await exec("git", ["checkout", mainBranch], { cwd: projectRoot });

    const restoreBranch = async () => {
      if (originalBranch) {
        try { await exec("git", ["checkout", originalBranch], { cwd: projectRoot }); } catch { /* ignore */ }
      }
    };

    try {
      if (squash) {
        try {
          await exec("git", ["merge", "--squash", "--", branchName], { cwd: projectRoot });
        } catch (e) {
          await exec("git", ["reset", "--hard", "HEAD"], { cwd: projectRoot }).catch(() => {});
          await restoreBranch();
          throw new Error(`Squash merge failed: ${e}`);
        }
        const msg = message ?? "Squash merge";
        try {
          await exec("git", ["commit", "-m", msg], { cwd: projectRoot });
        } catch (e) {
          await exec("git", ["reset", "--hard", "HEAD"], { cwd: projectRoot }).catch(() => {});
          await restoreBranch();
          throw new Error(`Commit failed: ${e}`);
        }
      } else {
        try {
          await exec("git", ["merge", "--", branchName], { cwd: projectRoot });
        } catch (e) {
          await exec("git", ["merge", "--abort"], { cwd: projectRoot }).catch(() => {});
          await restoreBranch();
          throw new Error(`Merge failed: ${e}`);
        }
      }
    } catch (e) {
      throw e;
    }

    invalidateMergeBaseCache();

    if (cleanup) {
      await removeWorktree(projectRoot, branchName, true);
    }

    return { main_branch: mainBranch, lines_added: linesAdded, lines_removed: linesRemoved };
  });
}

export async function getBranchLog(worktreePath: string): Promise<string> {
  const mainBranch = await detectMainBranch(worktreePath).catch(() => "HEAD");
  try {
    const { stdout } = await exec("git", ["log", `${mainBranch}..HEAD`, "--pretty=format:- %s"], { cwd: worktreePath });
    return stdout;
  } catch {
    return "";
  }
}

export async function pushTask(projectRoot: string, branchName: string): Promise<void> {
  await exec("git", ["push", "-u", "origin", "--", branchName], { cwd: projectRoot });
}

export async function rebaseTask(worktreePath: string): Promise<void> {
  const lockKey = await detectRepoLockKey(worktreePath).catch(() => worktreePath);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = await detectMainBranch(worktreePath);
    try {
      await exec("git", ["rebase", mainBranch], { cwd: worktreePath });
    } catch (e) {
      await exec("git", ["rebase", "--abort"], { cwd: worktreePath }).catch(() => {});
      throw new Error(`Rebase failed: ${e}`);
    }
    invalidateMergeBaseCache();
  });
}
