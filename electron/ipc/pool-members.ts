import fs from 'fs';
import path from 'path';

/**
 * Member discovery for pooled workspaces.
 *
 * A pooled environment is a directory holding several independent git
 * repositories side by side. Which repositories those are is either stated by
 * a manifest the workspace already keeps for its own setup script, or — when
 * there is none — discovered by looking one level down for git repositories.
 *
 * Nothing here runs git or touches the environment beyond reading it, so the
 * parsing rules stay unit-testable on fixtures.
 */

/** Manifest filenames probed at an environment root, in order. */
export const MANIFEST_FILENAMES = ['repos.tsv'] as const;

/**
 * The environment's own repository, when the root is itself a checkout.
 *
 * It is named `.` because that is what its path is relative to the
 * environment, and because everything that re-roots a path under a member
 * name has to leave this one alone: its files already sit at the root.
 */
export const ROOT_MEMBER = '.';

export interface PoolMemberSpec {
  /** Directory name under the environment root. */
  name: string;
  /** Branch the manifest pins this repository to, when it names one. */
  branch?: string;
}

/**
 * A member name becomes a path segment under the environment root, so it is
 * validated rather than trusted: a manifest is a file inside a repository and
 * a checkout is not a trust boundary. Leading dots are rejected too, which
 * keeps `.git`, `.worktrees` and the pool's own `.parallel-code` out of the
 * member list whichever way they were proposed.
 */
export function isSafeMemberName(name: string): boolean {
  if (name.length === 0 || name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('\n') || name.includes('\r')) return false;
  if (name !== name.trim()) return false;
  return true;
}

/**
 * Parse a `name<TAB>url[<TAB>branch]` manifest.
 *
 * Fields are split on any run of whitespace rather than on tabs alone: the
 * Winston dev-env's own `repos.tsv` has a space-separated row, and a manifest
 * that a human maintains will keep acquiring them. Blank lines and `#`
 * comments are skipped, the first entry wins on a duplicate name, and a row
 * whose name would not be a safe path segment is dropped rather than failing
 * the whole file — one bad row should not cost the other eleven.
 */
export function parseRepoManifest(text: string): PoolMemberSpec[] {
  const seen = new Set<string>();
  const members: PoolMemberSpec[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, , branch] = line.split(/\s+/);
    if (!name || !isSafeMemberName(name) || seen.has(name)) continue;
    seen.add(name);
    members.push({ name, branch: branch || undefined });
  }
  return members;
}

/** Read the first manifest present at an environment root, if any. */
export function readManifest(envPath: string): PoolMemberSpec[] | null {
  for (const filename of MANIFEST_FILENAMES) {
    try {
      const text = fs.readFileSync(path.join(envPath, filename), 'utf8');
      return parseRepoManifest(text);
    } catch {
      // Absent or unreadable — try the next name, then fall back to a scan.
    }
  }
  return null;
}

/** Whether `dir` is a git repository: `.git` as a directory or a worktree file. */
export function isGitCheckout(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/** Directories one level under `envPath` that are git repositories. */
export function scanForMembers(envPath: string): PoolMemberSpec[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(envPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSafeMemberName(entry.name))
    .filter((entry) => isGitCheckout(path.join(envPath, entry.name)))
    .map((entry) => ({ name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The member repositories of one environment.
 *
 * `configured` is the project's own list and wins outright when set, because a
 * user who narrowed the list meant it. Otherwise a manifest is preferred over a
 * scan, since it names repositories that belong to the workspace even while
 * they are missing — a distinction the readiness check needs and a scan of the
 * filesystem cannot make.
 *
 * Entries are filtered to what is actually checked out; `missing` carries the
 * rest, so "you have not run the setup script yet" stays a different answer
 * from "this environment has no repositories".
 *
 * The environment root itself is included when it is a git checkout, since a
 * workspace that is a repository of repositories still has files of its own.
 */
export function discoverMembers(
  envPath: string,
  configured?: string[],
): { members: PoolMemberSpec[]; missing: string[] } {
  const declared = configured?.length
    ? configured
        .filter((name) => name === ROOT_MEMBER || isSafeMemberName(name))
        .map((name) => ({
          name,
        }))
    : (readManifest(envPath) ?? scanForMembers(envPath));
  const members: PoolMemberSpec[] = [];
  const missing: string[] = [];

  // The workspace's own repository participates like any other: a change can
  // touch the manifest, a shared script or the instructions at the root. A
  // manifest never lists it — it is the repository the manifest lives in — so
  // it is added here rather than declared. An explicit member list names the
  // full set, so there it is included only when it says so.
  const includesRoot = configured?.length ? configured.includes(ROOT_MEMBER) : true;
  if (includesRoot && isGitCheckout(envPath)) members.push({ name: ROOT_MEMBER });

  for (const spec of declared) {
    if (spec.name === ROOT_MEMBER) continue; // already handled above
    if (isGitCheckout(path.join(envPath, spec.name))) members.push(spec);
    else missing.push(spec.name);
  }
  return { members, missing };
}
