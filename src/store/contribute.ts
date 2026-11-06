/** Contributing to Parallel Code itself, through its own issue browser and task flow. */
import { errMessage } from '../lib/log';
import { resolveGitHubRepository } from './github';
import type { Project } from './types';

export const UPSTREAM_REPOSITORY = 'johannesjo/parallel-code';
export const CONTRIBUTING_URL = `https://github.com/${UPSTREAM_REPOSITORY}/blob/main/CONTRIBUTING.md`;
/** Forks, clones, and adds the `upstream` remote that makes gh resolve the upstream repository. */
export const FORK_COMMAND = `gh repo fork ${UPSTREAM_REPOSITORY} --clone`;

export interface CheckoutSearch {
  project: Project | null;
  /** Why gh resolved no project at all, when that is the case; the checkout may be among them. */
  lookupError: string | null;
}

/**
 * The first project gh resolves to the upstream repository: a clone of it, or a
 * fork checkout with an `upstream` remote. A fork without one resolves to the
 * fork, whose issues are not the upstream ones, so it does not count.
 */
export async function findParallelCodeProject(projects: Project[]): Promise<CheckoutSearch> {
  const lookups = await Promise.allSettled(projects.map((p) => resolveGitHubRepository(p.path)));
  const index = lookups.findIndex(
    (r) => r.status === 'fulfilled' && r.value.toLowerCase() === UPSTREAM_REPOSITORY,
  );
  if (index !== -1) return { project: projects[index], lookupError: null };
  // A project gh cannot resolve is usually just not on github.com. Only when it
  // resolves none is gh itself the likely problem (missing, logged out, offline).
  const first = lookups[0];
  const allFailed = lookups.every((r) => r.status === 'rejected');
  return {
    project: null,
    lookupError: allFailed && first?.status === 'rejected' ? errMessage(first.reason) : null,
  };
}
