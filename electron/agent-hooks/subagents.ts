import { isServerCommand } from './server-command.js';
import { describeShells, isSiblingResult, type AgentHookStatusUpdate } from './status.js';

/** Hook update after the gate; null drops the event. */
type SubagentGate = (
  launchId: string,
  payload: unknown,
  update: AgentHookStatusUpdate | null,
) => AgentHookStatusUpdate | null;

/** Claude Code's name for an MCP tool call it moved to the background. */
const MCP_TASK = 'MCP task';
/** Background work the lead waits on. Shell commands count too, unless they
 *  look like servers or are Monitor watchers: `Stop` only names those. Monitor
 *  and cloud-session tasks are left out: they run until stopped or outlive the turn. */
const HELD_TASK_TYPES: ReadonlySet<string> = new Set(['subagent', 'workflow', 'shell', MCP_TASK]);
const WORKFLOW_AGENT = 'workflow-subagent';

interface LaunchWork {
  open: Set<string>;
  /** Names of the running workflows, as Claude last listed them. */
  workflows: string[];
  /** The running shell commands and MCP tool calls, as Claude last listed them. */
  shells: unknown[];
  /** Commands started with the Monitor tool that may still run. */
  monitors: readonly string[];
  /** Workflow agents running now, and how many have finished. */
  agents: Set<string>;
  agentsDone: number;
  leadIdle: boolean;
  leadMessage?: string;
  /** The prompt last let through, while it still stands. */
  prompt?: AgentHookStatusUpdate;
}

function field(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Claude's list of background tasks; undefined when the payload has none. */
function backgroundTasks(payload: unknown): unknown[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const tasks = (payload as Record<string, unknown>).background_tasks;
  return Array.isArray(tasks) ? tasks : undefined;
}

/** Claude clips a listed command at 1000 characters and appends this. */
const CLIP_MARK = /… \[\+\d+ chars\]$/;

/** True when a listed shell task runs the command a Monitor call started. */
function runsCommand(task: unknown, command: string): boolean {
  const listed = field(task, 'command');
  if (listed === undefined || field(task, 'status') !== 'running') return false;
  const head = listed.replace(CLIP_MARK, '');
  return head === listed ? command === listed : command.startsWith(head);
}

/**
 * The Monitor commands that may still run after this event. Claude lists a
 * Monitor as a plain `shell` task, so its command is the only way to tell it
 * apart. A watcher waits for something to happen, often for as long as its
 * timeout allows, so it must not hold the task `working` the way a test run does.
 */
function monitorsAfter(prev: readonly string[], payload: unknown): readonly string[] {
  const event = field(payload, 'hook_event_name');
  // Only a Monitor that started counts, so a denied call leaves nothing behind.
  if (event === 'PostToolUse' && field(payload, 'tool_name') === 'Monitor') {
    const input = (payload as Record<string, unknown>).tool_input;
    const command = field(input, 'command');
    return command && !prev.includes(command) ? [...prev, command] : prev;
  }
  // The lead's turn end lists every watcher still running, so the rest are over.
  const tasks = event === 'Stop' ? backgroundTasks(payload) : undefined;
  if (!tasks) return prev;
  return prev.filter((command) => tasks.some((task) => runsCommand(task, command)));
}

/** Held tasks Claude lists as running; undefined when the payload has no list. */
function runningTasks(payload: unknown, monitors: readonly string[]): unknown[] | undefined {
  return backgroundTasks(payload)?.filter((task) => {
    const type = field(task, 'type') ?? '';
    if (!HELD_TASK_TYPES.has(type) || field(task, 'status') !== 'running') return false;
    if (type !== 'shell') return true;
    if (monitors.some((command) => runsCommand(task, command))) return false;
    return !isServerCommand(field(task, 'command') ?? '');
  });
}

/** The launch's open background work after this event. */
function track(prev: LaunchWork | undefined, payload: unknown): LaunchWork {
  const event = field(payload, 'hook_event_name');
  const id = field(payload, 'agent_id');
  const monitors = monitorsAfter(prev?.monitors ?? [], payload);
  const listed = runningTasks(payload, monitors);
  // Claude's own list wins when present, healing a stop we never saw. A
  // sub-agent's stop still lists itself, so its own event applies after.
  const ids = listed?.map((task) => field(task, 'id')).filter((v) => v !== undefined);
  const open = new Set(ids ?? prev?.open);
  const workflows = listed
    ? listed
        .filter((task) => field(task, 'type') === 'workflow')
        .map((task) => field(task, 'name') ?? 'workflow')
    : (prev?.workflows ?? []);
  const shells = listed
    ? listed.filter((task) => {
        const type = field(task, 'type');
        return type === 'shell' || type === MCP_TASK;
      })
    : (prev?.shells ?? []);
  // A finished workflow's agent counts must not carry into the next one.
  const fresh = listed !== undefined && workflows.length === 0;
  const agents = new Set(fresh ? [] : prev?.agents);
  let agentsDone = fresh ? 0 : (prev?.agentsDone ?? 0);
  if (event === 'SubagentStart' && id) {
    open.add(id);
    if (field(payload, 'agent_type') === WORKFLOW_AGENT) agents.add(id);
  }
  if (event === 'SubagentStop' && id) {
    open.delete(id);
    if (agents.delete(id)) agentsDone += 1;
  }
  // A new session starts with no sub-agents; a lost stop must not pin `working`.
  if (event === 'SessionStart' && field(payload, 'source') !== 'compact') open.clear();
  const leadIdle = prev?.leadIdle ?? false;
  const { leadMessage, prompt } = prev ?? {};
  const counts = { agents, agentsDone };
  return { open, workflows, shells, monitors, ...counts, leadIdle, leadMessage, prompt };
}

/** What a launch with no open work still has to remember: its watchers. */
function settled(monitors: readonly string[]): LaunchWork {
  const none = { open: new Set<string>(), workflows: [], shells: [], agents: new Set<string>() };
  return { ...none, monitors, agentsDone: 0, leadIdle: false };
}

/** The status shown while the lead idles at its prompt, waiting on background work. */
function held(work: LaunchWork): AgentHookStatusUpdate {
  const base = {
    state: 'working',
    event: 'SubagentRunning',
    lastAssistantMessage: work.leadMessage,
    background: true,
  } as const;
  // A workflow's progress says more than a shell beside it, so it wins the line.
  if (work.workflows.length === 0) {
    const detail = describeShells(work.shells);
    if (!detail) return base;
    const first = work.shells[0];
    const toolName = field(first, 'type') === MCP_TASK ? (field(first, 'tool') ?? 'MCP') : 'Bash';
    return { ...base, toolName, detail };
  }
  const names = work.workflows.join(', ');
  const detail = `${names} · ${work.agents.size} running · ${work.agentsDone} done`;
  return { ...base, toolName: 'Workflow', detail };
}

/** The prompt still standing after this update, by the reducer's own rule:
 *  silent events and sibling results leave it, anything else ends it. */
function promptAfter(
  prompt: AgentHookStatusUpdate | undefined,
  update: AgentHookStatusUpdate | null,
): AgentHookStatusUpdate | undefined {
  if (update?.state === 'waiting') return update;
  if (!update || (prompt && isSiblingResult(prompt, update))) return prompt;
  return undefined;
}

/**
 * Keeps an agent `working` while a background sub-agent, workflow, shell
 * command, or MCP tool call it started still runs; servers and Monitor
 * watchers do not count. Claude Code ends the lead turn (`Stop`, later `idle_prompt`) as
 * soon as either is launched, which would report the task finished for its
 * whole run. So that end is held as `working`, and updates are flagged
 * `background` while the lead sits at its prompt. Unmatched `SubagentStop`s
 * occur (Claude's own helpers), so sub-agents are tracked by id.
 */
export function createSubagentGate(): SubagentGate {
  // shortcut: entries of a launch that dies mid-sub-agent or with a Monitor
  // running are never removed — a few ids or commands per crashed launch; hook
  // retireAgentLaunch if that ever matters.
  const launches = new Map<string, LaunchWork>();
  return (launchId, payload, update) => {
    const work = track(launches.get(launchId), payload);
    if (work.open.size === 0) {
      if (work.monitors.length === 0) launches.delete(launchId);
      else launches.set(launchId, settled(work.monitors));
      return update;
    }
    // The lead's turn end becomes a hold that keeps its reply for the card. A
    // failed turn is not held: its error needs you more than the work it left.
    if (update?.state === 'done' && update.event !== 'StopFailure') {
      // The idle reminder that follows `Stop` carries no reply; keep the one we have.
      const leadMessage = update.lastAssistantMessage ?? work.leadMessage;
      launches.set(launchId, { ...work, leadIdle: true, leadMessage, prompt: undefined });
      return held({ ...work, leadMessage });
    }
    // Only sub-agent events carry an agent id; anything else from the lead means
    // it is working again, and Esc can interrupt it.
    const leadIdle = work.leadIdle && (!update || field(payload, 'agent_id') !== undefined);
    const prompt = promptAfter(work.prompt, update);
    launches.set(launchId, { ...work, leadIdle, prompt });
    if (!leadIdle) return update;
    // Workflow progress replaces its agents' tool chatter, but never a prompt
    // that still stands: a sibling's progress must not hide it.
    if (work.workflows.length > 0 && !prompt) return held(work);
    return update ? { ...update, background: true } : update;
  };
}
