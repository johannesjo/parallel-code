/** The `git` invocation every document-workspace module shares. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { debug as logDebug } from '../log.js';

const execFileAsync = promisify(execFile);
/** A document's history can be large; `git log -p` on it must not be truncated. */
const MAX_BUFFER = 20 * 1024 * 1024;

export async function git(cwd: string, args: string[]): Promise<string> {
  logDebug('git', args.join(' '));
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** `git` for commands whose failure is an answer rather than an error. */
export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}
