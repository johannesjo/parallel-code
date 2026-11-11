import { isDeepStrictEqual } from 'util';
import type { AgentHookStatusUpdate } from './status.js';

/** Hook update after matching; null stays null. */
type ToolCallMatcher = (
  launchId: string,
  payload: unknown,
  update: AgentHookStatusUpdate | null,
) => AgentHookStatusUpdate | null;

interface OpenCall {
  id: string;
  subagentId?: string;
  toolName: string;
  input: unknown;
}

/** Far more calls than an agent runs at once: the oldest are calls whose
 *  result never came, such as one whose permission was denied. */
const MAX_OPEN_CALLS = 64;
/** A launch that dies mid-turn never sends the `Stop` that forgets its calls. */
const MAX_LAUNCHES = 32;

function toolInput(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>).tool_input
    : undefined;
}

/** The open call a permission request asks about: the latest one with the same
 *  input, else that agent's latest call of the tool. Latest, because a rejected
 *  call never gets a result and a retry repeats its input. */
function askedCall(
  calls: readonly OpenCall[],
  update: AgentHookStatusUpdate,
  input: unknown,
): OpenCall | undefined {
  const latestFirst = calls
    .filter((call) => call.subagentId === update.subagentId && call.toolName === update.toolName)
    .reverse();
  return latestFirst.find((call) => isDeepStrictEqual(call.input, input)) ?? latestFirst[0];
}

/**
 * Gives a `PermissionRequest` the id of the tool call it asks about. Claude
 * Code sends none with it, and without one the dialog cannot tell its own
 * call's result from a parallel call's. So the calls each launch has started
 * (`PreToolUse`) but not finished are remembered until their result or the
 * turn's end. A request no open call matches keeps no id.
 */
export function createToolCallMatcher(): ToolCallMatcher {
  const launches = new Map<string, OpenCall[]>();
  const remember = (launchId: string, calls: OpenCall[]) => {
    // Re-inserted so the launch heard from longest ago is the one evicted.
    launches.delete(launchId);
    if (calls.length === 0) return;
    launches.set(launchId, calls.slice(-MAX_OPEN_CALLS));
    const oldest = launches.keys().next().value;
    if (launches.size > MAX_LAUNCHES && oldest !== undefined) launches.delete(oldest);
  };
  return (launchId, payload, update) => {
    const calls = launches.get(launchId) ?? [];
    const { event, toolUseId: id, toolName, subagentId } = update ?? {};
    if (event === 'PreToolUse' && id && toolName) {
      const open = calls.filter((call) => call.id !== id);
      remember(launchId, [...open, { id, subagentId, toolName, input: toolInput(payload) }]);
    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      remember(
        launchId,
        calls.filter((call) => call.id !== id),
      );
    } else if (event === 'Stop' || event === 'StopFailure' || event === 'SessionStart') {
      // A compaction's SessionStart maps to no update, so it keeps the calls.
      launches.delete(launchId);
    } else if (event === 'PermissionRequest' && update && !id) {
      const asked = askedCall(calls, update, toolInput(payload));
      if (asked) return { ...update, toolUseId: asked.id };
    }
    return update;
  };
}
