/**
 * Thin wrapper around the GitHub CLI. Every GitHub feature shells out to the
 * user's own `gh`, so auth, hosts and tokens stay where the user configured
 * them and nothing is stored by the app.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import type { PrMergeable } from '../ipc/shared-types.js';

const exec = promisify(execFile);

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;

/** Runs `gh` and returns stdout. Failures throw with a user-facing message. */
export async function runGh(args: string[], cwd?: string, input?: string): Promise<string> {
  try {
    const pending = exec('gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
    });
    if (input !== undefined) pending.child.stdin?.end(input);
    const { stdout } = await pending;
    return stdout;
  } catch (err) {
    // Node reports a missing cwd as `spawn gh ENOENT` too; don't claim gh is missing.
    if (cwd && isGhSpawnMissing(err) && !existsSync(cwd)) {
      throw new Error(`Project folder not found: ${cwd}`);
    }
    throw new Error(describeGhError(err));
  }
}

function isGhSpawnMissing(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; path?: unknown; syscall?: unknown };
  const spawnedGh =
    e.path === 'gh' || (typeof e.syscall === 'string' && e.syscall.includes('spawn gh'));
  return e.code === 'ENOENT' && spawnedGh;
}

export async function runGhJson(args: string[], cwd?: string, input?: string): Promise<unknown> {
  return JSON.parse(await runGh(args, cwd, input)) as unknown;
}

/** Maps a failed `gh` invocation to a message the user can act on. */
export function describeGhError(err: unknown): string {
  const e = (err ?? {}) as { stderr?: unknown; killed?: unknown; message?: unknown };
  // A gh the user's terminal finds can still be outside the app's PATH (#316).
  if (isGhSpawnMissing(err)) {
    return "GitHub CLI (gh) was not found on the app's PATH. Install it from https://cli.github.com, or if it is already installed, add its folder to PATH in your shell profile and restart Parallel Code.";
  }
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  // Before the auth check: gh's unknown-host error also suggests `gh auth login`.
  if (
    /no git remotes found|none of the git remotes .* point to a known github host/i.test(stderr)
  ) {
    return 'This project has no GitHub remote. For GitHub Enterprise, run "gh auth login --hostname <host>".';
  }
  if (/not logged into|authentication required|gh auth login/i.test(stderr)) {
    return 'GitHub CLI is not logged in. Run "gh auth login" in a terminal.';
  }
  // With several remotes and no default, gh refuses to guess the repository.
  if (/gh repo set-default/i.test(stderr)) {
    return 'GitHub CLI does not know which repository to use. Run "gh repo set-default" in the project folder.';
  }
  if (/rate limit/i.test(stderr)) {
    return 'GitHub API rate limit reached. Try again in a few minutes.';
  }
  if (e.killed === true) return 'GitHub CLI timed out.';
  const lastLine = stderr.split('\n').filter(Boolean).pop();
  if (lastLine) return `gh: ${lastLine}`;
  return typeof e.message === 'string' ? e.message : String(err);
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseMergeable(v: unknown): PrMergeable {
  return v === 'MERGEABLE' || v === 'CONFLICTING' ? v : 'UNKNOWN';
}

/** `{ login }` author objects as returned by `gh --json author`. */
export function authorLogin(v: unknown): string {
  return asString(asRecord(v)?.['login']) ?? 'unknown';
}

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

/** Parses an HTTPS PR URL; gh handles host support and authentication. */
export function parsePrRef(url: string): PrRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const [owner, repo, kind, num] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repo || kind !== 'pull' || !/^\d+$/.test(num ?? '')) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return {
    host: u.host === 'www.github.com' ? 'github.com' : u.host,
    owner,
    repo,
    number: Number(num),
  };
}
