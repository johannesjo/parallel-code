import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const exec = promisify(execFile);

/** Stop scanning once this many foreign-owned entries are known — enough to explain the failure. */
const MAX_REPORTED = 5;
/** Upper bound on directory entries visited, so a huge node_modules cannot stall a close. */
const SCAN_BUDGET = 20_000;
/** A recursive chown over a large worktree is slow on bind mounts; give it room but don't hang. */
const CHOWN_TIMEOUT_MS = 120_000;

/**
 * Image used for the throwaway chown container. The agent image is already
 * present whenever the task ran in Docker mode; `alpine` is the fallback for
 * host-mode tasks whose agent shelled out to containers of its own.
 * Kept local (not imported from pty.ts) to avoid a git.ts <-> pty.ts cycle.
 */
const AGENT_IMAGE = 'parallel-code-agent:latest';
const FALLBACK_IMAGE = 'alpine';

export interface ForeignOwnedEntry {
  /** Absolute path of the entry. */
  path: string;
  /** Owning uid — the container user that created it. */
  uid: number;
}

/**
 * Collect entries under `root` that are not owned by `uid`.
 *
 * Containers that run as root (or as a uid with no host mapping, which lands as
 * `nobody`) leave files behind whose parent directory is not writable by the
 * desktop user. Those entries cannot be unlinked, so every rmdir up the chain
 * fails with ENOTEMPTY and the worktree can never be removed.
 *
 * Symlinks are inspected but never followed — a symlinked `node_modules` must
 * not drag the scan into the main checkout.
 */
export function findForeignOwnedEntries(
  root: string,
  uid: number,
  limit = MAX_REPORTED,
): ForeignOwnedEntry[] {
  const found: ForeignOwnedEntry[] = [];
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.uid !== uid) found.push({ path: root, uid: rootStat.uid });
  } catch {
    return found;
  }

  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && found.length < limit && visited < SCAN_BUDGET) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — nothing more we can learn from it
    }
    for (const entry of entries) {
      if (++visited >= SCAN_BUDGET || found.length >= limit) break;
      const full = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.uid !== uid) found.push({ path: full, uid: stat.uid });
      else if (stat.isDirectory()) stack.push(full);
    }
  }
  return found;
}

/**
 * Hand ownership of `worktreePath` back to the desktop user via a throwaway
 * root container. This is the only way to recover without sudo: the files are
 * owned by a foreign uid, so the desktop user can neither unlink nor chmod them.
 *
 * Deliberately a chown and not an `rm -rf` inside the container: every path the
 * container can reach ends up owned by the user who already owns the checkout,
 * so a mis-resolved mount cannot destroy anything.
 *
 * Returns null on success, or a short reason the reclaim could not be done.
 */
export async function reclaimOwnership(
  worktreePath: string,
  uid: number,
  gid: number,
): Promise<string | null> {
  // The two cases where no correct `docker run` can be built: `-v host:container`
  // has no escape for a colon in the host path, and chown needs a real uid.
  if (worktreePath.includes(':')) return 'the worktree path contains ":"';
  if (uid < 0 || gid < 0) return 'the current user id is unknown';

  const run = (image: string, pullNever: boolean): Promise<unknown> =>
    exec(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '0:0',
        ...(pullNever ? ['--pull', 'never'] : []),
        '--entrypoint',
        'chown',
        '-v',
        `${worktreePath}:/target`,
        image,
        '-R',
        `${uid}:${gid}`,
        '/target',
      ],
      { timeout: CHOWN_TIMEOUT_MS },
    );

  // `--pull never` keeps the agent-image attempt from stalling on a registry
  // lookup when the image was never built on this machine.
  try {
    await run(AGENT_IMAGE, true);
    return null;
  } catch {
    // Image missing or Docker unavailable — retry with the small public image.
  }
  try {
    await run(FALLBACK_IMAGE, false);
    return null;
  } catch (e: unknown) {
    return firstLine(e);
  }
}

/**
 * Build an actionable error for a worktree that cannot be removed because a
 * container left foreign-owned files in it and the automatic reclaim failed.
 */
export function foreignOwnedRemovalError(
  worktreePath: string,
  entries: ForeignOwnedEntry[],
  reclaimFailure: string,
): Error {
  const examples = entries
    .slice(0, 3)
    .map((e) => path.relative(worktreePath, e.path) || '.')
    .join(', ');
  const uids = [...new Set(entries.map((e) => e.uid))].join(', ');
  return new Error(
    `Cannot remove worktree "${worktreePath}": it contains files owned by uid ${uids} ` +
      `(e.g. ${examples}), left behind by a container that ran as root. ` +
      `Automatic cleanup via Docker failed: ${reclaimFailure}. ` +
      `Remove them manually, then close the task again: sudo rm -rf "${worktreePath}"`,
  );
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0].trim() || 'unknown error';
}
