import type { AgentDef } from '../ipc/types';
import type { Task } from '../store/types';
import { resolveSkipPermissionsArgs } from '../../electron/shared/skip-permissions';
import { newSessionArgs, resumeSessionArgs } from '../../electron/shared/session-resume';
import { isHiddenAgentTaskId } from '../documents/task-id';

function isCodexCommand(command: string): boolean {
  return command.split('/').pop()?.includes('codex') === true;
}

function isAntigravityCommand(command: string): boolean {
  return command.split('/').pop() === 'agy';
}

function isKimiCommand(command: string): boolean {
  return command.split('/').pop() === 'kimi';
}

function isCopilotCommand(command: string): boolean {
  return command.split('/').pop() === 'copilot';
}

/**
 * Output that means "the session I was told to resume is not there", which the
 * exit handler turns into one silent retry from a fresh session.
 *
 * Both Claude strings are quoted from the installed CLI: the first is what
 * `--continue` says when the directory has no history, the second what
 * `--resume <id>` says for an id that is gone. The second matters now that
 * panes carry an explicit id — a pruned `~/.claude/projects`, a changed
 * `CLAUDE_CONFIG_DIR` or a session the agent never got round to writing would
 * otherwise wedge the pane at "Process exited" on every single launch.
 *
 * No Codex entry: its stale-id message is not verified here, and a wrong
 * pattern either never fires or fires on healthy output and discards a live
 * session. A missing pattern only costs the automatic retry.
 */
const RESUME_FAILURE_PATTERNS: Record<string, string[]> = {
  claude: ['No conversation found to continue', 'No conversation found with session ID'],
};

export function isResumeArgsFailure(command: string, lastOutput: string[]): boolean {
  const base = command.split('/').pop() ?? command;
  const patterns = RESUME_FAILURE_PATTERNS[base];
  if (!patterns || lastOutput.length === 0) return false;
  const text = lastOutput.join('\n');
  return patterns.some((pattern) => text.includes(pattern));
}

function legacyMcpConfigArgs(command: string, mcpConfigPath: string | undefined): string[] {
  // Codex, Antigravity, and Kimi have no `--mcp-config` flag; passing it would break launch.
  if (
    !mcpConfigPath ||
    isCodexCommand(command) ||
    isAntigravityCommand(command) ||
    isKimiCommand(command)
  )
    return [];
  // Copilot has no `--mcp-config` flag either — it exits with "unknown option" (#146).
  // Use its `--additional-mcp-config <@file>` flag, which takes the same config shape.
  if (isCopilotCommand(command)) return ['--additional-mcp-config', `@${mcpConfigPath}`];
  return ['--mcp-config', mcpConfigPath];
}

/** The session-id flags for this launch, or null when the CLI has none or this
 *  pane has no id yet. Naming the session supersedes every positional rule
 *  below it, including the document-workspace picker — both exist only because
 *  "the latest session here" can belong to another terminal. */
function explicitSessionArgs(
  agentDef: AgentDef,
  resumed: boolean,
  sessionId: string | undefined,
): string[] | null {
  if (!sessionId) return null;
  const sessionArgs = resumed
    ? resumeSessionArgs(agentDef.command, sessionId)
    : newSessionArgs(agentDef.command, sessionId);
  if (!sessionArgs) return null;

  const configured = resumed && agentDef.resume_args?.length ? agentDef.resume_args : agentDef.args;
  // Keep the configured model, permissions and other options. Only the
  // selectors that would compete with this pane's session are replaced.
  const remaining: string[] = [];
  const codex = isCodexCommand(agentDef.command);
  const resumeIndex = codex ? configured.indexOf('resume') : -1;
  for (let i = 0; i < configured.length; i++) {
    const arg = configured[i];
    if (arg === '--') {
      remaining.push(...configured.slice(i));
      break;
    }
    if (codex) {
      if (arg === '--last') continue;
      if (i === resumeIndex) {
        if (configured[i + 1] && !configured[i + 1].startsWith('-')) i++;
        continue;
      }
    } else {
      if (arg === '--continue' || arg === '-c') continue;
      if (/^--(?:resume|session-id)=/.test(arg)) continue;
      if (arg === '--resume' || arg === '-r' || arg === '--session-id') {
        if (configured[i + 1] && !configured[i + 1].startsWith('-')) i++;
        continue;
      }
    }
    remaining.push(arg);
  }
  return [...sessionArgs, ...remaining];
}

type AgentLaunchTask = Pick<Task, 'skipPermissions' | 'mcpConfigPath' | 'mcpLaunchArgs'> &
  Partial<
    Pick<Task, 'id' | 'agentIds' | 'codexChatThreadId' | 'codexChatHandoff' | 'claudeChatSessionId'>
  >;

function positionalAgentArgs(
  agentDef: AgentDef,
  task: AgentLaunchTask,
  resumed: boolean,
): string[] {
  let args = resumed && agentDef.resume_args?.length ? agentDef.resume_args : agentDef.args;
  // A task's separate chat may now be the newest conversation. Let the user
  // choose the terminal conversation instead of resuming the chat by accident.
  // Without a chat, "latest" stays the default: a picker on every pane that
  // has no saved session id would block restoring older tasks after restart.
  if (
    resumed &&
    task.codexChatThreadId &&
    isCodexCommand(agentDef.command) &&
    args.join(' ') === 'resume --last'
  ) {
    args = ['resume'];
  }
  if (
    resumed &&
    task.claudeChatSessionId &&
    agentDef.command.split('/').pop() === 'claude' &&
    args.join(' ') === '--continue'
  ) {
    args = ['--resume'];
  }
  if (resumed && isHiddenAgentTaskId(task.id ?? null)) {
    // Hidden agents share the project checkout. "Latest" may belong to another
    // terminal: use a picker, without rewriting explicit IDs or custom flags.
    const command = agentDef.command.split('/').pop();
    const resume = args.join(' ');
    if (isCodexCommand(agentDef.command) && resume === 'resume --last') args = ['resume'];
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
  return args;
}

/**
 * Full argument list for a task's agent launch.
 *
 * `sessionId` names the conversation this pane owns, when the CLI supports it
 * (see session-resume.ts). Without one, resume stays positional ("the most
 * recent session in this directory"); Codex and Claude switch to their pickers
 * only where "latest" is ambiguous: a separate chat or a hidden agent.
 */
export function buildTaskAgentArgs(
  agentDef: AgentDef,
  task: AgentLaunchTask,
  resumed: boolean,
  agentId?: string,
  sessionId?: string,
): string[] {
  let args =
    explicitSessionArgs(agentDef, resumed, sessionId) ??
    positionalAgentArgs(agentDef, task, resumed);
  const session = task.codexChatHandoff;
  if (
    resumed &&
    agentId &&
    agentId === task.agentIds?.[0] &&
    session?.threadId &&
    isCodexCommand(agentDef.command)
  ) {
    args = [
      'resume',
      session.threadId,
      ...(session.model ? ['--model', session.model] : []),
      ...(session.reasoningEffort
        ? ['-c', `model_reasoning_effort=${JSON.stringify(session.reasoningEffort)}`]
        : []),
    ];
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

/** Recognize the built-in picker launches without interpreting custom CLI options. */
export function taskAgentOpensSessionPicker(
  ...launch: Parameters<typeof buildTaskAgentArgs>
): boolean {
  const [agentDef, , resumed] = launch;
  if (!resumed) return false;
  const selector = isCodexCommand(agentDef.command)
    ? 'resume'
    : agentDef.command.split('/').pop() === 'claude'
      ? '--resume'
      : undefined;
  const configuredArgs = agentDef.resume_args?.length ? agentDef.resume_args : agentDef.args;
  // Reviewer model overrides do not change whether the resume command opens a picker.
  const configured = configuredArgs
    .filter((arg, index) => arg !== '--model' && configuredArgs[index - 1] !== '--model')
    .join(' ');
  if (
    !selector ||
    (configured !== selector &&
      configured !== (selector === 'resume' ? 'resume --last' : '--continue'))
  ) {
    return false;
  }
  const args = buildTaskAgentArgs(...launch);
  return args[0] === selector && args[1] !== '--last' && (!args[1] || args[1].startsWith('-'));
}
