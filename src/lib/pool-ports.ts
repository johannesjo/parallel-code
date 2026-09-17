import type { PoolConfig, Task } from '../store/types';

/**
 * Ports for a leased environment.
 *
 * Two tasks in a pool run two copies of the same applications, so they cannot
 * both serve on an application's default port. The port belongs to the
 * environment rather than to the task: a lease comes and goes, but a person
 * who learns that MRW2 serves the till on 3511 should keep being right.
 *
 * `PORT` is what a member repository's own start script reads first, so one
 * variable per task shell covers the common case of running one application.
 * `PARALLEL_CODE_PORT_<REPO>` carries the whole map for anything that starts
 * more than one, with the repository name upper-cased and non-alphanumerics
 * folded to `_` so it is a legal shell identifier.
 */

/** A member repo's port: the environment's base plus that repo's offset. */
export function memberPort(
  pool: PoolConfig,
  envPath: string,
  memberName: string,
): number | undefined {
  const base = pool.portBase?.[envPath];
  const offset = pool.portOffsets?.[memberName];
  if (base === undefined || offset === undefined) return undefined;
  return base + offset;
}

/** `waiter-app` → `PARALLEL_CODE_PORT_WAITER_APP`. */
export function portVarName(memberName: string): string {
  return `PARALLEL_CODE_PORT_${memberName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Environment variables for a pool task's terminals.
 *
 * Returns nothing at all when the project configured no ports, so a workspace
 * that does not serve anything is not handed a misleading `PORT`.
 */
export function poolPortEnv(
  pool: PoolConfig | undefined,
  task: Pick<Task, 'gitIsolation' | 'envPath' | 'repos'>,
): Record<string, string> {
  if (!pool || task.gitIsolation !== 'pool' || !task.envPath || !task.repos) return {};
  const env: Record<string, string> = {};
  for (const repo of task.repos) {
    const port = memberPort(pool, task.envPath, repo.name);
    if (port !== undefined) env[portVarName(repo.name)] = String(port);
  }
  if (Object.keys(env).length === 0) return {};

  // `PORT` is the one an unconfigured start script picks up, so it names the
  // lowest-numbered member: whichever application the environment's own port
  // layout puts first, rather than whichever repo happened to be listed first.
  const lowest = Object.values(env)
    .map(Number)
    .sort((a, b) => a - b)[0];
  env.PORT = String(lowest);
  env.PARALLEL_CODE_ENV_PATH = task.envPath;
  return env;
}
