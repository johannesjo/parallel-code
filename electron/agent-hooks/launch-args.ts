import path from 'path';

/** True for `claude` and absolute paths to it; wrappers with other names get nothing. */
export function isClaudeCommand(command: string): boolean {
  return path.basename(command) === 'claude';
}

/**
 * Append `--settings <hooks file>` to a Claude Code launch. Left alone when
 * the user already passes their own `--settings` — the last one wins in
 * Claude's parser and silently dropping theirs would be worse than missing
 * status for that task.
 */
export function withClaudeHookSettings(
  command: string,
  args: readonly string[],
  settingsPath: string,
): string[] {
  if (!isClaudeCommand(command)) return [...args];
  if (args.some((arg) => arg === '--settings' || arg.startsWith('--settings='))) return [...args];
  return [...args, '--settings', settingsPath];
}
