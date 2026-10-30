import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BaseUpstreamDivergence } from './shared-types.js';

const exec = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_COMMITS = 10;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout.trim();
}

const lines = (text: string) => text.split('\n').filter(Boolean);

function parseCommits(text: string): { hash: string; subject: string }[] {
  return lines(text).map((line) => {
    const space = line.indexOf(' ');
    return space < 0
      ? { hash: line, subject: '' }
      : { hash: line.slice(0, space), subject: line.slice(space + 1) };
  });
}

/** `origin/main` for `main`, as configured by `git branch -u`; undefined without one. */
export async function upstreamOf(cwd: string, branch: string): Promise<string | undefined> {
  try {
    return (
      (await git(cwd, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        `${branch}@{upstream}`,
      ])) || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * The base has commits that are neither on its upstream nor on the task, and
 * is behind its upstream too. Merging the task, which may already carry the
 * upstream's version of the same work, then conflicts with those local commits.
 * Reads refs as of the last fetch; undefined when the base tracks nothing.
 */
export async function baseUpstreamDivergence(
  worktreePath: string,
  mainBranch: string,
): Promise<BaseUpstreamDivergence | undefined> {
  const upstream = await upstreamOf(worktreePath, mainBranch);
  if (!upstream) return undefined;
  // `--not HEAD`: base commits the task already has would land with it anyway.
  const localRange = [mainBranch, '--not', upstream, 'HEAD'];
  const [count, behind] = await Promise.all([
    git(worktreePath, ['rev-list', '--count', ...localRange]),
    git(worktreePath, ['rev-list', '--count', `${mainBranch}..${upstream}`]),
  ]);
  const localCount = parseInt(count, 10) || 0;
  const behindCount = parseInt(behind, 10) || 0;
  if (!localCount || !behindCount) return undefined;
  const [log, touched, differing, head] = await Promise.all([
    git(worktreePath, ['log', `-${MAX_COMMITS}`, '--format=%h %s', ...localRange]),
    git(worktreePath, [
      'log',
      '--format=',
      '--name-only',
      '--no-renames',
      '--diff-merges=first-parent',
      ...localRange,
    ]),
    git(worktreePath, ['diff', '--name-only', '--no-renames', upstream, mainBranch]),
    git(worktreePath, ['rev-parse', mainBranch]),
  ]);
  const touchedSet = new Set(lines(touched));
  return {
    upstream,
    head,
    behind: behindCount,
    local_count: localCount,
    local_commits: parseCommits(log),
    differing_files: lines(differing).filter((file) => touchedSet.has(file)),
  };
}

/**
 * ` main commits that changed them: abc1234 subject (not on origin/main), …`
 * Names the base side of a conflict, so the user knows which work collided.
 * Empty when git cannot tell; a missing note must not hide the conflict itself.
 */
export async function conflictSourcesNote(
  cwd: string,
  refs: { mainBranch: string; branch: string },
  files: string[],
): Promise<string> {
  if (!files.length) return '';
  try {
    const { mainBranch, branch } = refs;
    const upstream = await upstreamOf(cwd, mainBranch);
    const [log, localOnly] = await Promise.all([
      git(cwd, ['log', '-3', '--format=%H %h %s', mainBranch, '--not', branch, '--', ...files]),
      upstream ? git(cwd, ['rev-list', `${upstream}..${mainBranch}`]) : Promise.resolve(''),
    ]);
    const commits = parseCommits(log);
    if (!commits.length) return '';
    const local = new Set(lines(localOnly));
    const text = commits
      .map((c) => `${c.subject}${local.has(c.hash) ? ` (not on ${upstream})` : ''}`)
      .join(', ');
    return ` ${mainBranch} commits that changed them: ${text}.`;
  } catch {
    return '';
  }
}
