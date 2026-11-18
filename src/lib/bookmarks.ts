/** Extract a short label from a command string. */
export function extractLabel(command: string): string {
  const words = command.trim().split(/\s+/);
  // Walk backwards, skip flags (words starting with -)
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w.startsWith('-')) continue;
    // Strip path prefixes and file extensions
    const base = w.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '');
    if (base) return base;
  }
  return words[0] ?? 'cmd';
}

/** Ephemeral map for passing initial commands from spawn to TerminalView. */
const pendingCommands = new Map<string, string>();

export function setPendingShellCommand(shellId: string, command: string): void {
  pendingCommands.set(shellId, command);
}

export function consumePendingShellCommand(shellId: string): string | undefined {
  const cmd = pendingCommands.get(shellId);
  if (cmd !== undefined) pendingCommands.delete(shellId);
  return cmd;
}

/** A program a task terminal runs in place of the user's shell. */
export interface ShellLaunch {
  command: string;
  args: string[];
  /** The agent's env file, so the program runs with the same account and settings. */
  envFile?: string;
}

/** Ephemeral map for passing a direct launch from spawn to TerminalView; argv skips shell quoting. */
const pendingLaunches = new Map<string, ShellLaunch>();

/** Terminals running a program, not a shell, for their whole life: never reused for commands. */
const programShells = new Set<string>();

export function setPendingShellLaunch(shellId: string, launch: ShellLaunch): void {
  pendingLaunches.set(shellId, launch);
  programShells.add(shellId);
}

/** Whether a task terminal runs a program; a quiet one is not a shell prompt waiting for input. */
export function isProgramShell(shellId: string): boolean {
  return programShells.has(shellId);
}

export function consumePendingShellLaunch(shellId: string): ShellLaunch | undefined {
  const launch = pendingLaunches.get(shellId);
  if (launch !== undefined) pendingLaunches.delete(shellId);
  return launch;
}
