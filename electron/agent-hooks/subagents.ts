import { isSiblingResult, type AgentHookStatusUpdate } from './status.js';

/** Hook update after the gate; null drops the event. */
type SubagentGate = (
  launchId: string,
  payload: unknown,
  update: AgentHookStatusUpdate | null,
) => AgentHookStatusUpdate | null;

/** Background work the lead waits on. Shell commands are left out on purpose:
 *  a backgrounded dev server would hold a finished task busy (see
 *  `shell_busy` in src/store/taskStatus.ts); `Stop` reports them instead. */
const HELD_TASK_TYPES: ReadonlySet<string> = new Set(['subagent', 'workflow']);
const WORKFLOW_AGENT = 'workflow-subagent';

interface LaunchWork {
  open: Set<string>;
  /** Names of the running workflows, as Claude last listed them. */
  workflows: string[];
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

/** Held tasks Claude lists as running; undefined when the payload has no list. */
function runningTasks(payload: unknown): unknown[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const tasks = (payload as Record<string, unknown>).background_tasks;
  if (!Array.isArray(tasks)) return undefined;
  return tasks.filter(
    (task) => HELD_TASK_TYPES.has(field(task, 'type') ?? '') && field(task, 'status') === 'running',
  );
}

/** The launch's open background work after this event. */
function track(prev: LaunchWork | undefined, payload: unknown): LaunchWork {
  const event = field(payload, 'hook_event_name');
  const id = field(payload, 'agent_id');
  const listed = runningTasks(payload);
  // Claude's own list wins when present, healing a stop we never saw. A
  // sub-agent's stop still lists itself, so its own event applies after.
  const ids = listed?.map((task) => field(task, 'id')).filter((v) => v !== undefined);
  const open = new Set(ids ?? prev?.open);
  const workflows = listed
    ? listed
        .filter((task) => field(task, 'type') === 'workflow')
        .map((task) => field(task, 'name') ?? 'workflow')
    : (prev?.workflows ?? []);
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
  return { open, workflows, agents, agentsDone, leadIdle, leadMessage, prompt };
}

/** The status shown while the lead idles at its prompt, waiting on background work. */
function held(work: LaunchWork): AgentHookStatusUpdate {
  const base = {
    state: 'working',
    event: 'SubagentRunning',
    lastAssistantMessage: work.leadMessage,
    background: true,
  } as const;
  if (work.workflows.length === 0) return base;
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
 * Keeps an agent `working` while a background sub-agent or workflow it started
 * still runs. Claude Code ends the lead turn (`Stop`, later `idle_prompt`) as
 * soon as either is launched, which would report the task finished for its
 * whole run. So that end is held as `working`, and updates are flagged
 * `background` while the lead sits at its prompt. Unmatched `SubagentStop`s
 * occur (Claude's own helpers), so sub-agents are tracked by id.
 */
export function createSubagentGate(): SubagentGate {
  // shortcut: entries of a launch that dies mid-sub-agent are never removed —
  // a few ids per crashed launch; hook retireAgentLaunch if that ever matters.
  const launches = new Map<string, LaunchWork>();
  return (launchId, payload, update) => {
    const work = track(launches.get(launchId), payload);
    if (work.open.size === 0) {
      launches.delete(launchId);
      return update;
    }
    // The lead's turn end becomes a hold that keeps its reply for the card.
    if (update?.state === 'done') {
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
