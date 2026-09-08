import fs from 'fs';
import path from 'path';

/**
 * Worktrees share the main checkout's `node_modules` via symlinks. A single
 * whole-directory symlink breaks dev tooling: Vite 5+ writes its bundled TS
 * config to `node_modules/.vite-temp/` and its dep-optimizer cache to
 * `node_modules/.vite/`, and those writes resolve through the symlink into the
 * main checkout — which agent sandboxes mount read-only (EROFS). So
 * `node_modules` is materialized as a real per-worktree directory containing
 * one symlink per top-level entry (pnpm-style layout): reads still resolve to
 * the main checkout, while root-level cache dirs are created as real, writable,
 * per-worktree directories.
 */

/**
 * Dot-entries that are package-manager metadata and must be linked for the
 * tree to resolve (`.bin`, pnpm's store and state, yarn's install state).
 * Every other dot-entry is treated as a tool cache (`.vite`, `.vite-temp`,
 * `.cache`, …) and deliberately not linked, so tools create their own writable
 * per-worktree cache instead of writing through a link into the main checkout.
 * An unlisted metadata file only costs a cold cache, never a failure.
 */
const NODE_MODULES_DOT_ALLOW = new Set([
  '.bin',
  '.pnpm',
  '.package-lock.json',
  '.modules.yaml',
  '.yarn-integrity',
  '.yarn-state.yml',
]);

function isLinkableEntry(name: string): boolean {
  return !name.startsWith('.') || NODE_MODULES_DOT_ALLOW.has(name);
}

/** lstat that treats a missing or unreadable path as absent. */
function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** readlink that treats a missing or non-symlink path as absent. */
function readlinkOrNull(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/** Resolve a symlink destination against the link's parent directory. */
function resolveLinkDest(linkPath: string, dest: string): string {
  return path.resolve(path.dirname(linkPath), dest);
}

/** realpath that treats a missing or unresolvable path as absent. */
export function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Whether the symlink at `linkPath` is one of ours: a link to the entry
 * `name` inside the source `node_modules`. Compares lexically first, then via
 * realpath of the destination's parent — a repo opened through a symlinked
 * path bakes that alias into its links while `git rev-parse` reports the
 * canonical root, and both must count as the same source. Comparing only the
 * parent (not the full destination) keeps pnpm sources matchable, whose
 * entries realpath into `.pnpm/`.
 */
function isEntryLinkInto(
  lexicalSource: string,
  canonicalSource: string | null,
  linkPath: string,
  name: string,
): boolean {
  const dest = readlinkOrNull(linkPath);
  if (dest === null) return false;
  const resolved = resolveLinkDest(linkPath, dest);
  if (path.basename(resolved) !== name) return false;
  if (path.dirname(resolved) === lexicalSource) return true;
  return canonicalSource !== null && realpathOrNull(path.dirname(resolved)) === canonicalSource;
}

/**
 * Idempotently make `targetDir` a real directory of per-entry symlinks into
 * `sourceDir`. Migrates a legacy whole-dir symlink at `targetDir`, adds links
 * for entries new in the source, and prunes links left dangling by entries
 * removed from the source. Real (non-symlink) entries in the target — tool
 * caches, worktree-local installs — are never touched. Failures are logged
 * per entry and never thrown; a partially linked tree still resolves for the
 * entries that succeeded.
 *
 * Callers are responsible for only pointing this at a `node_modules` they
 * manage (see `isManagedNodeModules`) — an existing symlink at `targetDir` is
 * replaced unconditionally.
 *
 * Returns whether `targetDir` is now a managed tree; false means nothing was
 * materialized (no source, or the target could not be prepared).
 */
export function ensureNodeModulesEntryLinks(sourceDir: string, targetDir: string): boolean {
  let sourceEntries: string[];
  try {
    sourceEntries = fs.readdirSync(sourceDir);
  } catch (err) {
    // No node_modules in the source (yet) is normal; anything else is not.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Failed to read ${sourceDir}:`, err);
    }
    return false;
  }

  if (lstatOrNull(targetDir)?.isSymbolicLink()) {
    try {
      fs.unlinkSync(targetDir);
    } catch (err) {
      console.warn(`Failed to remove node_modules symlink at ${targetDir}:`, err);
      return false;
    }
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    console.warn(`Failed to create ${targetDir}:`, err);
    return false;
  }

  let targetEntries: fs.Dirent[];
  try {
    targetEntries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`Failed to readdir ${targetDir}:`, err);
    return false;
  }
  const present = new Set(targetEntries.map((entry) => entry.name));

  for (const name of sourceEntries) {
    if (!isLinkableEntry(name)) continue;
    if (present.has(name)) continue;
    try {
      // Relative links survive the repo being moved or reached through a
      // different path alias.
      const dest = path.relative(targetDir, path.join(sourceDir, name));
      fs.symlinkSync(dest, path.join(targetDir, name));
    } catch (err) {
      console.warn(`Failed to link node_modules entry '${name}':`, err);
    }
  }

  pruneRemovedEntryLinks(sourceDir, targetDir, sourceEntries, targetEntries);
  return true;
}

/**
 * Remove links for entries that no longer exist in the source. Only links
 * that provably point into the source are deleted — a foreign symlink the
 * worktree created is kept, dangling or not. Links named after a live source
 * entry are never pruned, so a dangling entry *in the source* doesn't churn
 * (and a transient error probing the source can't delete a live link, which
 * an existence check would).
 */
function pruneRemovedEntryLinks(
  sourceDir: string,
  targetDir: string,
  sourceEntries: string[],
  targetEntries: fs.Dirent[],
): void {
  const sourceNames = new Set(sourceEntries);
  const lexicalSource = path.resolve(sourceDir);
  const canonicalSource = realpathOrNull(sourceDir);
  for (const entry of targetEntries) {
    if (!entry.isSymbolicLink()) continue;
    if (sourceNames.has(entry.name)) continue;
    const linkPath = path.join(targetDir, entry.name);
    if (!isEntryLinkInto(lexicalSource, canonicalSource, linkPath, entry.name)) continue;
    try {
      fs.unlinkSync(linkPath);
    } catch (err) {
      console.warn(`Failed to prune node_modules entry '${entry.name}':`, err);
    }
  }
}

/**
 * Whether `targetDir` is a `node_modules` this app manages against
 * `sourceDir`: the legacy whole-dir symlink to it, or a real directory holding
 * at least one entry link into it. A user-managed real install (no entry
 * links, e.g. `npm ci` run inside the worktree) and a symlink to anywhere else
 * both return false and must be left alone.
 */
export function isManagedNodeModules(sourceDir: string, targetDir: string): boolean {
  const stat = lstatOrNull(targetDir);
  if (!stat) return false;

  const lexicalSource = path.resolve(sourceDir);
  const canonicalSource = realpathOrNull(sourceDir);

  if (stat.isSymbolicLink()) {
    const dest = readlinkOrNull(targetDir);
    if (dest === null) return false;
    const resolved = resolveLinkDest(targetDir, dest);
    if (resolved === lexicalSource) return true;
    return canonicalSource !== null && realpathOrNull(resolved) === canonicalSource;
  }
  if (!stat.isDirectory()) return false;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(targetDir, entry.name);
    if (isEntryLinkInto(lexicalSource, canonicalSource, linkPath, entry.name)) {
      return true;
    }
  }
  return false;
}
