import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import {
  getAllFileDiffs,
  getChangedFiles,
  getFileDiff,
  getUncommittedChangedFiles,
  getUncommittedFileDiffs,
} from './git.js';
import type { ChangedFile, FileDiffResult, NestedRepo } from './shared-types.js';

const exec = promisify(execFile);

/** Caps the git calls a panel refresh can trigger in a folder full of clones. */
const MAX_NESTED_REPOS = 10;
/** Nested repos rarely appear or switch branch, and panels refresh every few seconds. */
const NESTED_REPO_TTL_MS = 30_000;

const nestedRepoCache = new Map<string, { expiresAt: number; repos: Promise<NestedRepo[]> }>();

/**
 * Git repositories in top-level folders of a task's worktree that the task's
 * own repository does not track — typically sibling projects symlinked into
 * the worktree so one agent can edit several repos at once. Cached briefly.
 */
export function findNestedRepos(worktreePath: string): Promise<NestedRepo[]> {
  const now = Date.now();
  const cached = nestedRepoCache.get(worktreePath);
  if (cached && cached.expiresAt > now) return cached.repos;
  for (const [key, entry] of nestedRepoCache) {
    if (entry.expiresAt <= now) nestedRepoCache.delete(key);
  }
  const repos = scanNestedRepos(worktreePath);
  nestedRepoCache.set(worktreePath, { expiresAt: now + NESTED_REPO_TTL_MS, repos });
  return repos;
}

async function scanNestedRepos(worktreePath: string): Promise<NestedRepo[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(worktreePath, { withFileTypes: true });
  } catch (err) {
    console.warn(`Failed to scan ${worktreePath} for nested repositories:`, err);
    return [];
  }
  // Only a filesystem check per entry, so projects without nested repos pay no git calls.
  const names = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => name !== '.git' && fs.existsSync(path.join(worktreePath, name, '.git')))
    .sort()
    .slice(0, MAX_NESTED_REPOS);
  const repos = await Promise.all(names.map((name) => describeNestedRepo(worktreePath, name)));
  return repos.filter((repo): repo is NestedRepo => repo !== null);
}

async function describeNestedRepo(worktreePath: string, name: string): Promise<NestedRepo | null> {
  try {
    // Submodules and other tracked paths already appear in the task's own diff.
    const { stdout: tracked } = await exec('git', ['ls-files', '--', name], { cwd: worktreePath });
    if (tracked.trim()) return null;
    const { stdout: branch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: path.join(worktreePath, name),
    });
    return { name, branch: branch.trim() };
  } catch (err) {
    console.warn(`Skipping nested repository '${name}' in ${worktreePath}:`, err);
    return null;
  }
}

function isInsideRepo(filePath: string, repo: NestedRepo): boolean {
  return filePath === repo.name || filePath.startsWith(`${repo.name}/`);
}

function prefixChangedFile(file: ChangedFile, repo: NestedRepo): ChangedFile {
  return {
    ...file,
    path: `${repo.name}/${file.path}`,
    ...(file.previous_path ? { previous_path: `${repo.name}/${file.previous_path}` } : {}),
  };
}

/** Runs `read` in every nested repo; a broken nested repo must not hide the task's own changes. */
async function readNestedRepos<T>(
  worktreePath: string,
  read: (repoPath: string, repo: NestedRepo) => Promise<T>,
  fallback: T,
): Promise<{ repos: NestedRepo[]; results: T[] }> {
  const repos = await findNestedRepos(worktreePath);
  const results = await Promise.all(
    repos.map((repo) =>
      read(path.join(worktreePath, repo.name), repo).catch((err: unknown) => {
        console.warn(`Failed to read changes of nested repository '${repo.name}':`, err);
        return fallback;
      }),
    ),
  );
  return { repos, results };
}

async function withNestedChangedFiles(
  worktreePath: string,
  own: Promise<ChangedFile[]>,
  read: (repoPath: string) => Promise<ChangedFile[]>,
): Promise<ChangedFile[]> {
  const [ownFiles, nested] = await Promise.all([
    own,
    readNestedRepos(
      worktreePath,
      (repoPath, repo) =>
        read(repoPath).then((files) => files.map((file) => prefixChangedFile(file, repo))),
      [],
    ),
  ]);
  // An unignored nested folder shows up in the task's own list as one untracked entry.
  const ownOnly = ownFiles.filter(
    (file) => !nested.repos.some((repo) => isInsideRepo(file.path, repo)),
  );
  return [...ownOnly, ...nested.results.flat()];
}

async function withNestedDiffs(
  worktreePath: string,
  own: Promise<string>,
  read: (repoPath: string, pathPrefix: string) => Promise<string>,
): Promise<string> {
  const [ownDiff, nested] = await Promise.all([
    own,
    readNestedRepos(worktreePath, (repoPath, repo) => read(repoPath, `${repo.name}/`), ''),
  ]);
  return [ownDiff, ...nested.results].filter((part) => part.length > 0).join('\n');
}

/**
 * Changed files of the task plus those of its nested repos, each nested path
 * prefixed with its folder. Nested repos compare against their own main branch.
 */
export function getChangedFilesWithNested(
  worktreePath: string,
  baseBranch?: string,
): Promise<ChangedFile[]> {
  return withNestedChangedFiles(
    worktreePath,
    getChangedFiles(worktreePath, baseBranch),
    (repoPath) => getChangedFiles(repoPath),
  );
}

/** Uncommitted changes of the task and its nested repos. */
export function getUncommittedChangedFilesWithNested(worktreePath: string): Promise<ChangedFile[]> {
  return withNestedChangedFiles(
    worktreePath,
    getUncommittedChangedFiles(worktreePath),
    getUncommittedChangedFiles,
  );
}

/** Combined diff of the task and its nested repos, nested paths prefixed with their folder. */
export function getAllFileDiffsWithNested(
  worktreePath: string,
  baseBranch?: string,
): Promise<string> {
  return withNestedDiffs(
    worktreePath,
    getAllFileDiffs(worktreePath, baseBranch),
    (repoPath, prefix) => getAllFileDiffs(repoPath, undefined, prefix),
  );
}

/** Uncommitted diff of the task and its nested repos. */
export function getUncommittedFileDiffsWithNested(worktreePath: string): Promise<string> {
  return withNestedDiffs(
    worktreePath,
    getUncommittedFileDiffs(worktreePath),
    getUncommittedFileDiffs,
  );
}

/** File diff that routes a nested-repo path to the repo that owns it. */
export async function getFileDiffWithNested(
  worktreePath: string,
  filePath: string,
  baseBranch?: string,
): Promise<FileDiffResult> {
  const repos = await findNestedRepos(worktreePath);
  const repo = repos.find((candidate) => filePath.startsWith(`${candidate.name}/`));
  if (!repo) return getFileDiff(worktreePath, filePath, baseBranch);
  return getFileDiff(path.join(worktreePath, repo.name), filePath.slice(repo.name.length + 1));
}
