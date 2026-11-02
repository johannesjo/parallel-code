import { execFile } from 'child_process';
import { promisify } from 'util';
import { errMessage, warn as logWarn } from '../log.js';

const execFileAsync = promisify(execFile);
const MAX_NAMED = 3;

/**
 * The task worktree's `git status`, one entry per line; none when git fails,
 * which only costs the note on files the app changed.
 */
export async function worktreeStatus(cwd: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      // Without the index lock the task's own agent may need meanwhile.
      ['--no-optional-locks', 'status', '--porcelain'],
      { cwd },
    );
    return new Set(stdout.split('\n').filter(Boolean));
  } catch (error) {
    logWarn('taskScreens', 'Could not read the task status', { error: errMessage(error) });
    return undefined;
  }
}

/**
 * Names the files that serving the task changed in it, such as a generated
 * `next-env.d.ts`: they would show up in the task's diff.
 */
export function changedFilesNote(
  before: Set<string> | undefined,
  after: Set<string> | undefined,
): string | undefined {
  if (!before || !after) return undefined;
  // shortcut: compares status lines, so a file the task had already changed and serving changed again goes unseen; hash the files if that matters.
  const names = [...after].filter((line) => !before.has(line)).map((line) => line.slice(3));
  if (!names.length) return undefined;
  const more = names.length - MAX_NAMED;
  const listed = names.slice(0, MAX_NAMED).join(', ') + (more > 0 ? ` and ${more} more` : '');
  return `Starting the app changed files in the task: ${listed}.`;
}
