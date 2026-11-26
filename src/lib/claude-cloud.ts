/** Commands that hand a Claude Code task to claude.ai: Remote Control and cloud sessions. */

const MAX_SESSION_NAME = 80;

/** Whether an agent command runs the Claude Code CLI. */
export function isClaudeCommand(command: string): boolean {
  return command.split(/[/\\]/).pop() === 'claude';
}

/**
 * The slash command that turns on Remote Control. The first run names the
 * session after the task so it is recognisable on claude.ai; a later run
 * without a name opens the CLI's status panel, which can also disconnect.
 */
export function remoteControlCommand(taskName: string, connect: boolean): string {
  // The command is typed into the TUI, so a newline would submit it early.
  const name = taskName.replace(/\s+/g, ' ').trim().slice(0, MAX_SESSION_NAME);
  return connect && name ? `/remote-control ${name}` : '/remote-control';
}

/**
 * Arguments for `claude --cloud`; passed as argv, never through a shell, so no quoting.
 * One `--cloud=` argument: as a separate argument, a prompt starting with `-` is read as a flag.
 */
export function cloudLaunchArgs(prompt: string): string[] {
  return [`--cloud=${prompt.trim()}`];
}

/**
 * The default prompt for a cloud handoff. The cloud session starts without this conversation,
 * so it names the task. Not the prompt history: it records every answer typed into the
 * terminal and drops old entries.
 */
export function cloudHandoffPrompt(taskName: string): string {
  return `Continue this task: ${taskName}\nThe branch has the work so far.`;
}
