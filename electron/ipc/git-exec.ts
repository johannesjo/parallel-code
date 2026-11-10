// Traced child-process runners shared by the git IPC modules.

import { execFile, execFileSync as _execFileSync } from 'child_process';
import { promisify } from 'util';
import { debug as logDebug } from '../log.js';

const _exec = promisify(execFile);

/**
 * Trace + run a git command (or any execFile invocation).
 * Emits a `debug` entry under category `git` with the args before
 * execution so verbose logs can reconstruct the command stream.
 */
export const exec: typeof _exec = ((cmd: string, args: string[], options?: unknown) => {
  if (cmd === 'git') logDebug('git', args.join(' '));
  return (_exec as unknown as (...a: unknown[]) => unknown)(cmd, args, options);
}) as typeof _exec;

export const execFileSync: typeof _execFileSync = ((
  cmd: string,
  args: string[],
  options?: unknown,
) => {
  if (cmd === 'git') logDebug('git', args.join(' '));
  return (_execFileSync as unknown as (...a: unknown[]) => unknown)(cmd, args, options);
}) as typeof _execFileSync;

export const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
