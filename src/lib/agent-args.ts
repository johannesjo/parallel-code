import type { AgentDef } from '../ipc/types';
import type { Task } from '../store/types';
import { resolveSkipPermissionsArgs } from '../../electron/shared/skip-permissions';
import { isDocumentAgentTaskId } from '../documents/task-id';

function isCodexCommand(command: string): boolean {
  return command.split('/').pop()?.includes('codex') === true;
}

function isAntigravityCommand(command: string): boolean {
  return command.split('/').pop() === 'agy';
}

function isCopilotCommand(command: string): boolean {
  return command.split('/').pop() === 'copilot';
}

const RESUME_FAILURE_PATTERNS: Record<string, string[]> = {
  claude: ['No conversation found to continue'],
};

export function isResumeArgsFailure(command: string, lastOutput: string[]): boolean {
  const base = command.split('/').pop() ?? command;
  const patterns = RESUME_FAILURE_PATTERNS[base];
  if (!patterns || lastOutput.length === 0) return false;
  const text = lastOutput.join('\n');
  return patterns.some((pattern) => text.includes(pattern));
}

function legacyMcpConfigArgs(command: string, mcpConfigPath: string | undefined): string[] {
  // Codex and Antigravity have no `--mcp-config` flag; passing it would break launch.
  if (!mcpConfigPath || isCodexCommand(command) || isAntigravityCommand(command)) return [];
  // Copilot has no `--mcp-config` flag either — it exits with "unknown option" (#146).
  // Use its `--additional-mcp-config <@file>` flag, which takes the same config shape.
  if (isCopilotCommand(command)) return ['--additional-mcp-config', `@${mcpConfigPath}`];
  return ['--mcp-config', mcpConfigPath];
}

export function buildTaskAgentArgs(
  agentDef: AgentDef,
  task: Pick<Task, 'skipPermissions' | 'mcpConfigPath' | 'mcpLaunchArgs'> &
    Partial<Pick<Task, 'id'>>,
  resumed: boolean,
): string[] {
  let args = resumed && agentDef.resume_args?.length ? agentDef.resume_args : agentDef.args;
  if (resumed && isDocumentAgentTaskId(task.id ?? null)) {
    // Document terminals share a checkout. "Latest" may belong to another
    // terminal: use a picker, without rewriting explicit IDs or custom flags.
    const command = agentDef.command.split('/').pop();
    const resume = args.join(' ');
    if (command === 'codex' && resume === 'resume --last') args = ['resume'];
    if ((command === 'claude' || command === 'copilot') && resume === '--continue') {
      args = ['--resume'];
    }
    // These defaults have no verified CLI picker. A fresh session is safer
    // than silently continuing a different conversation; manual resume remains.
    if (
      (command === 'gemini' && resume === '--resume latest') ||
      (command === 'agy' && resume === '-c')
    ) {
      args = agentDef.args;
    }
  }
  return [
    ...args,
    // Resolved, not read straight off the def: a def restored from an older
    // profile or synthesised from a bare command carries no skip args, and
    // reading the field directly downgrades an explicit opt-in to a launch
    // that prompts on every tool call.
    ...(task.skipPermissions ? resolveSkipPermissionsArgs(agentDef) : []),
    ...(task.mcpLaunchArgs ?? legacyMcpConfigArgs(agentDef.command, task.mcpConfigPath)),
  ];
}
