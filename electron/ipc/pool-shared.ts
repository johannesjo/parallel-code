import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { runGit } from './git.js';
import type { PoolRepo } from './pool.js';

/**
 * Shared repositories that appear twice in an environment.
 *
 * Some workspaces check a shared library out both as a sibling repository at
 * the environment root and as a submodule inside each application that uses
 * it. The applications build against their submodule copy, so that is where a
 * change has to be made for the running application to pick it up — but the
 * copies are pinned independently and drift apart, so it is not where the
 * change should be committed.
 *
 * This module treats the sibling checkout as canonical: every copy is put on
 * the canonical repository's base branch before work starts, so all of them
 * share one base, and the change made in a copy is then carried back to the
 * canonical checkout as a patch that applies cleanly by construction. What is
 * committed and reviewed is then the same code that was actually run.
 *
 * Without the alignment step this would be applying a diff across a pin gap,
 * which can conflict or — worse — apply cleanly against stale code.
 */

/** One copy of a canonical member repository, living inside another one. */
export interface SharedMirror {
  /** Member repo the copy lives in, e.g. `waiter`. */
  hostName: string;
  /** Path of the copy, relative to its host, e.g. `packages/shared`. */
  subPath: string;
  /** Absolute path of the copy's checkout. */
  path: string;
  /** The canonical member repo it mirrors, e.g. the `shared` member. */
  canonical: PoolRepo;
}

/** Submodule paths declared by a repository's `.gitmodules`. */
export async function submodulePaths(repoPath: string): Promise<string[]> {
  if (!fs.existsSync(path.join(repoPath, '.gitmodules'))) return [];
  const out = await runGit(repoPath, [
    'config',
    '--file',
    '.gitmodules',
    '--get-regexp',
    '^submodule\\..*\\.path$',
  ]).catch(() => '');
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((value): value is string => Boolean(value));
}

/**
 * Every submodule in the environment that mirrors one of its member repos.
 *
 * The match is by directory name: `packages/shared` inside `waiter` mirrors
 * the member repo called `shared`. A submodule with no member of that name —
 * a vendored dependency, a skills checkout — is not a mirror and is left
 * alone, which is what keeps this from touching submodules the workspace does
 * not also keep a canonical copy of.
 */
export async function findSharedMirrors(repos: PoolRepo[]): Promise<SharedMirror[]> {
  const byName = new Map(repos.map((repo) => [repo.name, repo]));
  const mirrors: SharedMirror[] = [];
  for (const host of repos) {
    for (const subPath of await submodulePaths(host.path)) {
      const canonical = byName.get(path.basename(subPath));
      if (!canonical || canonical.path === host.path) continue;
      const mirrorPath = path.join(host.path, subPath);
      if (!fs.existsSync(mirrorPath)) continue;
      mirrors.push({ hostName: host.name, subPath, path: mirrorPath, canonical });
    }
  }
  return mirrors;
}

/** The commit a canonical repo's base branch is at, which every copy aligns to. */
async function canonicalBase(canonical: PoolRepo): Promise<string> {
  return runGit(canonical.path, ['rev-parse', canonical.baseBranch]);
}

export interface MirrorOutcome {
  mirror: string;
  error?: string;
}

/**
 * Put every mirror on its canonical repository's base branch.
 *
 * The commit is fetched from the canonical checkout on disk rather than from
 * the network: it is the same upstream repository, the objects are already
 * local, and a lease should not depend on connectivity.
 *
 * The copy is left detached on purpose. It is a build input for the duration
 * of the task, not somewhere commits belong — the canonical checkout is where
 * the branch and the commits live.
 */
export async function alignMirrors(mirrors: SharedMirror[]): Promise<MirrorOutcome[]> {
  const outcomes: MirrorOutcome[] = [];
  for (const mirror of mirrors) {
    const label = `${mirror.hostName}/${mirror.subPath}`;
    try {
      const base = await canonicalBase(mirror.canonical);
      await runGit(mirror.path, ['fetch', '--no-tags', mirror.canonical.path, base]);
      await runGit(mirror.path, ['checkout', '--detach', base]);
      outcomes.push({ mirror: label });
    } catch (err) {
      outcomes.push({ mirror: label, error: String(err) });
    }
  }
  return outcomes;
}

/** Whether a mirror holds work that is not in its canonical checkout yet. */
export async function mirrorPatch(mirror: SharedMirror): Promise<string> {
  const base = await canonicalBase(mirror.canonical);
  // Intent-to-add so a brand-new file appears in the diff; the index entry is
  // undone with the rest of the checkout when the environment is released.
  await runGit(mirror.path, ['add', '-A', '-N']).catch(() => '');
  return runGit(mirror.path, ['diff', '--binary', base]);
}

export interface AggregateOutcome extends MirrorOutcome {
  /** Set when the mirror had changes that were carried across. */
  applied?: boolean;
}

/**
 * Carry each mirror's changes into its canonical checkout.
 *
 * The patch is taken against the canonical base the mirror was aligned to, so
 * it covers both commits made inside the copy and uncommitted work, and it
 * applies to a checkout branched from that same base.
 *
 * The result is left in the canonical checkout's working tree rather than
 * committed: the message is the author's to write, and this runs before a
 * commit rather than instead of one. A patch that does not apply is reported
 * and the others still run — one conflicted library should not hide the rest.
 */
export async function aggregateMirrors(mirrors: SharedMirror[]): Promise<AggregateOutcome[]> {
  const outcomes: AggregateOutcome[] = [];
  for (const mirror of mirrors) {
    const label = `${mirror.hostName}/${mirror.subPath}`;
    try {
      const patch = await mirrorPatch(mirror);
      if (!patch.trim() || (await patchIsPresent(mirror.canonical.path, patch))) {
        outcomes.push({ mirror: label, applied: false });
        continue;
      }
      await runGitApply(mirror.canonical.path, ['--3way', '--whitespace=nowarn'], patch);
      outcomes.push({ mirror: label, applied: true });
    } catch (err) {
      outcomes.push({ mirror: label, error: String(err) });
    }
  }
  return outcomes;
}

/** Run `git apply` with a patch on stdin, so nothing is written to disk. */
async function runGitApply(repoPath: string, args: string[], patch: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['apply', ...args, '-'], { cwd: repoPath });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 4096);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git apply exited ${code}`));
    });
    proc.stdin?.end(patch.endsWith('\n') ? patch : `${patch}\n`);
  });
}

/**
 * Whether a checkout already contains a patch's changes.
 *
 * A patch that reverses cleanly is one that is already applied — the standard
 * idiom, and the only way to tell "carried across already" apart from "carried
 * across and then edited further" without keeping state of our own.
 */
async function patchIsPresent(repoPath: string, patch: string): Promise<boolean> {
  return runGitApply(repoPath, ['--check', '--reverse'], patch).then(
    () => true,
    () => false,
  );
}

/**
 * Mirrors still holding changes their canonical checkout has not taken.
 *
 * Used to refuse a push that would otherwise send the application branches
 * without the shared change they were written against.
 */
export async function unaggregatedMirrors(mirrors: SharedMirror[]): Promise<string[]> {
  const pending: string[] = [];
  for (const mirror of mirrors) {
    try {
      const patch = await mirrorPatch(mirror);
      if (!patch.trim()) continue;
      if (await patchIsPresent(mirror.canonical.path, patch)) continue;
      pending.push(`${mirror.hostName}/${mirror.subPath}`);
    } catch {
      // Unreadable copies are the environment status's problem, not this one.
    }
  }
  return pending;
}
