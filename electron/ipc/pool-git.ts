import path from 'path';

import { getAllFileDiffs, getChangedFiles, getFileDiff, getWorktreeStatus } from './git.js';
import type { PoolRepo } from './pool.js';
import { ROOT_MEMBER } from './pool-members.js';
import type { ChangedFile, FileDiffResult, WorktreeStatus } from './shared-types.js';

/**
 * The git surface of a pool task.
 *
 * A pool task spans every member repository of its leased environment, so
 * "the changed files" is the union of several repositories rather than one
 * repository's answer. Aggregation happens here rather than in the renderer
 * because the existing panels are built around a single path, and the one
 * thing that makes them work unchanged is that a member repository sits at a
 * fixed subdirectory of the environment: prefix each path with its repository
 * name and the result is a real path relative to the environment root, which
 * is exactly what those panels already hold.
 *
 * The same prefix read backwards routes a per-file request to the repository
 * that owns it.
 */

/**
 * Split an environment-relative path into its member repo and the rest.
 *
 * The environment's own repository carries no prefix — its files are already
 * at the root — so it is the fallback rather than a match, and a path that
 * belongs to a child repository is never mistaken for one of its files.
 */
export function splitRepoPath(
  repos: PoolRepo[],
  envRelativePath: string,
): { repo: PoolRepo; filePath: string } | null {
  const normalized = envRelativePath.split(path.sep).join('/');
  for (const repo of repos) {
    if (repo.name === ROOT_MEMBER) continue;
    const prefix = `${repo.name}/`;
    if (normalized.startsWith(prefix)) {
      return { repo, filePath: normalized.slice(prefix.length) };
    }
  }
  const root = repos.find((repo) => repo.name === ROOT_MEMBER);
  return root ? { repo: root, filePath: normalized } : null;
}

/** Re-root one repository's changed files at the environment. */
export function prefixChangedFiles(repoName: string, files: ChangedFile[]): ChangedFile[] {
  if (repoName === ROOT_MEMBER) return files; // already environment-relative
  return files.map((file) => ({
    ...file,
    path: `${repoName}/${file.path}`,
    previous_path: file.previous_path ? `${repoName}/${file.previous_path}` : undefined,
  }));
}

/**
 * Every member repository's changed files, as one list.
 *
 * A repository that cannot be read contributes nothing rather than failing the
 * call: a task spanning five repositories should still show the four that
 * answered, and the environment status is where an unreadable repository is
 * meant to surface.
 */
export async function poolChangedFiles(repos: PoolRepo[]): Promise<ChangedFile[]> {
  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      try {
        return prefixChangedFiles(repo.name, await getChangedFiles(repo.path, repo.baseBranch));
      } catch {
        return [];
      }
    }),
  );
  return perRepo.flat();
}

/**
 * Re-root the paths in one repository's unified diff at the environment.
 *
 * Only the path-bearing headers are rewritten, and each is anchored to the
 * start of its line, so a `+++ b/x` that appears inside an added line of the
 * body — a diff of a diff, or of a patch fixture — is left alone.
 */
export function prefixDiffPaths(repoName: string, diff: string): string {
  if (repoName === ROOT_MEMBER) return diff; // already environment-relative
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) {
        return line.replace(/ a\/(.*) b\/(.*)$/, ` a/${repoName}/$1 b/${repoName}/$2`);
      }
      if (line.startsWith('--- a/')) return `--- a/${repoName}/${line.slice(6)}`;
      if (line.startsWith('+++ b/')) return `+++ b/${repoName}/${line.slice(6)}`;
      if (line.startsWith('rename from ')) return `rename from ${repoName}/${line.slice(12)}`;
      if (line.startsWith('rename to ')) return `rename to ${repoName}/${line.slice(10)}`;
      return line;
    })
    .join('\n');
}

/**
 * Every member repository's diff, concatenated, with its paths re-rooted at
 * the environment so the viewer shows one change spanning several
 * repositories rather than several unrelated ones.
 */
export async function poolAllDiffs(repos: PoolRepo[]): Promise<string> {
  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      try {
        const diff = await getAllFileDiffs(repo.path, repo.baseBranch);
        return diff.trim() ? prefixDiffPaths(repo.name, diff) : '';
      } catch {
        return '';
      }
    }),
  );
  return perRepo.filter(Boolean).join('\n');
}

/** The diff of one file, routed to the member repository that owns it. */
export async function poolFileDiff(
  repos: PoolRepo[],
  envRelativePath: string,
): Promise<FileDiffResult> {
  const owner = splitRepoPath(repos, envRelativePath);
  if (!owner) throw new Error(`No pool repository owns "${envRelativePath}"`);
  return getFileDiff(owner.repo.path, owner.filePath, owner.repo.baseBranch);
}

export interface PoolRepoStatus extends WorktreeStatus {
  repo: string;
}

/**
 * Per-repository status plus the rolled-up answer the task header shows.
 *
 * The roll-up is a disjunction — any repository with changes makes the task
 * changed — and the branch is reported only when every repository agrees on
 * it, so a member left behind on its base branch is visible as "mixed" rather
 * than hidden behind the majority.
 */
export async function poolStatus(repos: PoolRepo[]): Promise<{
  perRepo: PoolRepoStatus[];
  combined: WorktreeStatus;
}> {
  const perRepo = await Promise.all(
    repos.map(async (repo) => ({
      repo: repo.name,
      ...(await getWorktreeStatus(repo.path, repo.baseBranch)),
    })),
  );

  const branches = new Set(perRepo.map((status) => status.current_branch));
  const baseBranches = new Set(perRepo.map((status) => status.base_branch));
  return {
    perRepo,
    combined: {
      has_committed_changes: perRepo.some((status) => status.has_committed_changes),
      has_uncommitted_changes: perRepo.some((status) => status.has_uncommitted_changes),
      current_branch: branches.size === 1 ? (perRepo[0]?.current_branch ?? null) : null,
      base_branch: baseBranches.size === 1 ? (perRepo[0]?.base_branch ?? null) : null,
    },
  };
}
