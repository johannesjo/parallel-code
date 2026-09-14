import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Resolve the exact file handed to a process launcher. Windows CreateProcess
 * does not search PATHEXT for us, and a .cmd file is not a native executable. */
export function resolveCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!command.trim()) throw new Error('Command must not be empty.');
  if (platform !== 'win32') {
    if (path.posix.isAbsolute(command)) {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    }
    return execFileSync('which', [command], { encoding: 'utf8', timeout: 3000 }).trim() || command;
  }

  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
  const hasExtension = path.win32.extname(command) !== '';
  const candidates = hasExtension ? [command] : extensions.map((ext) => command + ext);
  const pathValue = env.Path ?? env.PATH ?? env.path ?? '';
  const dirs = path.win32.isAbsolute(command) || /[\\/]/.test(command)
    ? ['']
    : pathValue.split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = dir ? path.win32.join(dir, candidate) : path.win32.resolve(candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // Try the next PATHEXT candidate.
      }
    }
  }
  throw new Error(`Command '${command}' not found in PATH.`);
}

/** A script shim must be started through cmd.exe under ConPTY. Keep each argv
 * element quoted so spaces and cmd metacharacters cannot turn into a command. */
export function windowsPtyCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args };
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
  };
}
