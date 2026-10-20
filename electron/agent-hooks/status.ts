/**
 * Agent-hook status contract shared by the main-process hook server and the
 * renderer store. Pure: no Node or Electron imports, so `src/` may import it.
 *
 * Only three wire states exist on purpose. "Idle" is never reported by a
 * hook — an agent is idle because it said `done`, or because its evidence
 * went stale. That keeps the hook layer free of the idle-vs-waiting guesswork
 * the terminal heuristics have to do.
 */

export type AgentHookStatusState = 'working' | 'waiting' | 'done';

/** What a `waiting` agent needs: a yes/no on a permission-style dialog, or
 *  answers to a structured question. The renderer uses this to tell an
 *  approval keystroke from a partial answer. */
export type AgentHookPrompt = 'permission' | 'question';

export interface AgentHookStatusUpdate {
  state: AgentHookStatusState;
  /** The originating hook event, e.g. `Stop` or `PreToolUse`. */
  event: string;
  prompt?: AgentHookPrompt;
  /** Tool in flight (`working`) or the tool a prompt is about (`waiting`). */
  toolName?: string;
  /** Claude's id for that tool call; lets a result be matched to the prompt it ends. */
  toolUseId?: string;
  /** Short human summary — a command, a file path, or the question asked. */
  detail?: string;
  /** Claude's final text for the turn; only present on turn boundaries. */
  lastAssistantMessage?: string;
}

/** Posted by the main process to the renderer for every accepted hook event. */
export interface AgentHookEventPayload extends AgentHookStatusUpdate {
  agentId: string;
  taskId: string;
  /** Present on every production event; optional for legacy in-process callers. */
  launchId?: string;
  /** Ordered cache observation sequence, absent on the raw scheduling stream. */
  sequence?: number;
  /** Epoch ms when the main process received the event. */
  at: number;
}

const DETAIL_MAX_CHARS = 200;
const LAST_MESSAGE_MAX_CHARS = 2000;

/** Notification types that mean Claude is blocked on the human. */
const WAITING_NOTIFICATION_TYPES = new Set([
  'permission_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length === 0) return undefined;
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** Vendors spell the ask-the-user tool differently; compare without punctuation. */
const HOOK_STATES: ReadonlySet<string> = new Set<AgentHookStatusState>([
  'working',
  'waiting',
  'done',
]);

/** Shape check at the renderer's IPC boundary; the wire is trusted but not typed. */
export function isAgentHookEventPayload(value: unknown): value is AgentHookEventPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.agentId === 'string' &&
    typeof v.taskId === 'string' &&
    typeof v.event === 'string' &&
    typeof v.at === 'number' &&
    typeof v.state === 'string' &&
    HOOK_STATES.has(v.state) &&
    Number.isFinite(v.at) &&
    (v.prompt === undefined || v.prompt === 'permission' || v.prompt === 'question') &&
    ['toolName', 'toolUseId', 'detail', 'lastAssistantMessage'].every(
      (key) => v[key] === undefined || typeof v[key] === 'string',
    )
  );
}

/** ExitPlanMode blocks on "proceed with this plan?" exactly like a permission dialog. */
export function isPlanApprovalTool(toolName: string | undefined): boolean {
  return toolName?.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'exitplanmode';
}

export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  const normalized = toolName?.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'askuserquestion' || normalized === 'requestuserinput';
}

/** The one field of a tool input a human recognises at a glance. */
function summarizeToolInput(toolInput: unknown): string | undefined {
  const input = asRecord(toolInput);
  if (!input) return undefined;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'description', 'prompt']) {
    const value = asString(input[key]);
    if (value) return clip(value, DETAIL_MAX_CHARS);
  }
  return undefined;
}

/** First question text of an AskUserQuestion input, if any. */
function summarizeQuestions(toolInput: unknown): string | undefined {
  const input = asRecord(toolInput);
  const questions = input?.questions;
  if (!Array.isArray(questions)) return undefined;
  const first = asRecord(questions[0]);
  return clip(asString(first?.question), DETAIL_MAX_CHARS);
}

function mapPreToolUse(body: Record<string, unknown>, toolName: string | undefined) {
  const event = 'PreToolUse';
  const toolUseId = asString(body.tool_use_id);
  if (isAskUserQuestionTool(toolName)) {
    const detail = summarizeQuestions(body.tool_input);
    return { state: 'waiting', event, toolName, toolUseId, detail, prompt: 'question' } as const;
  }
  if (isPlanApprovalTool(toolName)) {
    const detail = 'Plan ready for approval';
    return { state: 'waiting', event, toolName, toolUseId, detail, prompt: 'permission' } as const;
  }
  return {
    state: 'working',
    event,
    toolName,
    toolUseId,
    detail: summarizeToolInput(body.tool_input),
  } as const;
}

function mapNotification(body: Record<string, unknown>): AgentHookStatusUpdate | null {
  const event = 'Notification';
  const type = asString(body.notification_type);
  if (type === 'idle_prompt') return { state: 'done', event };
  if (!type || !WAITING_NOTIFICATION_TYPES.has(type)) return null;
  const detail = clip(asString(body.message), DETAIL_MAX_CHARS);
  if (type === 'permission_prompt')
    return { state: 'waiting', event, detail, prompt: 'permission' };
  return { state: 'waiting', event, detail };
}

/**
 * Map a raw Claude Code hook payload (the JSON Claude writes to the hook's
 * stdin) to a status update, or null when the event says nothing about
 * working/waiting/done.
 */
export function mapClaudeHookPayload(payload: unknown): AgentHookStatusUpdate | null {
  const body = asRecord(payload);
  const event = asString(body?.hook_event_name);
  if (!body || !event) return null;

  const toolName = asString(body.tool_name);
  const toolUseId = asString(body.tool_use_id);

  switch (event) {
    case 'SessionStart':
      // Compaction restarts the session mid-turn; the agent is still working.
      return body.source === 'compact' ? null : { state: 'done', event };
    case 'UserPromptSubmit':
      return { state: 'working', event };
    case 'PreToolUse':
      return mapPreToolUse(body, toolName);
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { state: 'working', event, toolUseId };
    case 'PermissionRequest': {
      const detail = summarizeToolInput(body.tool_input);
      return { state: 'waiting', event, toolName, toolUseId, detail, prompt: 'permission' };
    }
    case 'Notification':
      return mapNotification(body);
    case 'Stop':
    case 'StopFailure':
      return {
        state: 'done',
        event,
        ...(event === 'StopFailure'
          ? {
              detail: clip(
                [asString(body.error), asString(body.error_details)].filter(Boolean).join(': '),
                DETAIL_MAX_CHARS,
              ),
            }
          : {}),
        lastAssistantMessage: clip(asString(body.last_assistant_message), LAST_MESSAGE_MAX_CHARS),
      };
    default:
      return null;
  }
}

export const AGENT_HOOK_STALE_MS = 30 * 60_000;

export interface ActivityEvidence {
  agentId: string;
  /** Unknown for restored/chat processes that have no live PTY identity. */
  launchId?: string;
  source: 'hook' | 'terminal' | 'process';
  activity: 'working' | 'waiting' | 'ready' | 'turn_finished' | 'unknown';
  event: string;
  observedAt?: number;
  since?: number;
  prompt?: AgentHookPrompt;
  detail?: string;
  freshness: 'current' | 'stale' | 'unknown';
}

export interface ReducedAgentHookStatus extends AgentHookStatusUpdate {
  since: number;
  updatedAt: number;
}

/** Parallel sibling results do not dismiss another tool's human prompt. */
export function transitionAgentHookStatus(
  previous: ReducedAgentHookStatus | undefined,
  event: AgentHookStatusUpdate & { at: number },
): ReducedAgentHookStatus {
  if (
    previous?.state === 'waiting' &&
    (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') &&
    previous.toolUseId !== undefined &&
    event.toolUseId !== undefined &&
    previous.toolUseId !== event.toolUseId
  )
    return previous;
  // Claude's idle reminder re-reports a finished turn. After a failed turn it
  // says nothing new, and the failure must stay visible until a new turn starts.
  if (previous?.event === 'StopFailure' && event.state === 'done' && event.event === 'Notification')
    return previous;
  const sameState = previous?.state === event.state;
  const finished = (name: string) => name === 'Stop' || name === 'StopFailure';
  const sameActivity =
    sameState && (event.state !== 'done' || finished(previous.event) === finished(event.event));
  return {
    state: event.state,
    event: event.event,
    since: sameActivity ? previous.since : event.at,
    updatedAt: event.at,
    toolName: event.toolName,
    toolUseId:
      event.toolUseId ?? (sameState && event.state === 'waiting' ? previous.toolUseId : undefined),
    prompt: event.prompt ?? (sameState && event.state === 'waiting' ? previous.prompt : undefined),
    detail: event.detail ?? (sameState && event.state === 'done' ? previous.detail : undefined),
    lastAssistantMessage:
      event.lastAssistantMessage ??
      (sameState && event.state === 'done' ? previous.lastAssistantMessage : undefined),
  };
}

export function activityEvidenceFromHook(
  agentId: string,
  launchId: string | undefined,
  status: ReducedAgentHookStatus,
  now = Date.now(),
): ActivityEvidence {
  const finished = status.event === 'Stop' || status.event === 'StopFailure';
  return {
    agentId,
    launchId,
    source: 'hook',
    activity: status.state === 'done' ? (finished ? 'turn_finished' : 'ready') : status.state,
    event: status.event,
    observedAt: status.updatedAt,
    since: status.since,
    prompt: status.prompt,
    detail: status.detail,
    // A waiting agent is silent until answered, so only `working` goes stale.
    freshness:
      status.state === 'working' && now - status.updatedAt >= AGENT_HOOK_STALE_MS
        ? 'stale'
        : 'current',
  };
}

export type AgentActivityObservation =
  | {
      kind: 'launch' | 'retired' | 'invalidated';
      agentId: string;
      taskId: string;
      launchId: string;
      sequence: number;
      at: number;
    }
  | (AgentHookEventPayload & { kind: 'hook'; launchId: string; sequence: number; since: number });

export interface AgentActivitySnapshot {
  sequence: number;
  observations: AgentActivityObservation[];
}

export function isAgentActivityObservation(value: unknown): value is AgentActivityObservation {
  const v = asRecord(value);
  if (
    !v ||
    typeof v.agentId !== 'string' ||
    typeof v.taskId !== 'string' ||
    typeof v.launchId !== 'string' ||
    !v.launchId ||
    typeof v.at !== 'number' ||
    !Number.isFinite(v.at) ||
    typeof v.sequence !== 'number' ||
    !Number.isSafeInteger(v.sequence) ||
    v.sequence < 0
  )
    return false;
  if (v.kind === 'hook')
    return isAgentHookEventPayload(v) && typeof v.since === 'number' && Number.isFinite(v.since);
  return v.kind === 'launch' || v.kind === 'retired' || v.kind === 'invalidated';
}

export function isAgentActivitySnapshot(value: unknown): value is AgentActivitySnapshot {
  const v = asRecord(value);
  const watermark = v?.sequence;
  return (
    !!v &&
    typeof watermark === 'number' &&
    Number.isSafeInteger(watermark) &&
    watermark >= 0 &&
    Array.isArray(v.observations) &&
    v.observations.every(
      (observation: unknown) =>
        isAgentActivityObservation(observation) && observation.sequence <= watermark,
    )
  );
}
