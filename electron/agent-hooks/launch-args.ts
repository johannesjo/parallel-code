import path from 'path';

/** True for `claude` and absolute paths to it; wrappers with other names get nothing. */
export function isClaudeCommand(command: string): boolean {
  return path.basename(command) === 'claude';
}

/** True for `qoder` and absolute paths to it. Qoder's hook payloads match
 *  Claude Code's, so it shares the same script and route. */
export function isQoderCommand(command: string): boolean {
  return path.basename(command) === 'qoder';
}

/**
 * Append `--settings <hooks file>`, unless the user already passes their own —
 * the last one wins in the parser and silently dropping theirs would be worse
 * than missing status for that task.
 */
function withSettingsArg(args: readonly string[], settingsPath: string): string[] {
  if (args.some((arg) => arg === '--settings' || arg.startsWith('--settings='))) return [...args];
  return [...args, '--settings', settingsPath];
}

/** Append the Claude Code hook settings. */
export function withClaudeHookSettings(
  command: string,
  args: readonly string[],
  settingsPath: string,
): string[] {
  if (!isClaudeCommand(command)) return [...args];
  return withSettingsArg(args, settingsPath);
}

/** Append the hooks-only Qoder settings (no status line: Qoder has no verified
 *  equivalent). */
export function withQoderHookSettings(
  command: string,
  args: readonly string[],
  settingsPath: string,
): string[] {
  if (!isQoderCommand(command)) return [...args];
  return withSettingsArg(args, settingsPath);
}
