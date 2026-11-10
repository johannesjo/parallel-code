import { mapClaudeHookPayload, type AgentHookStatusUpdate } from './status.js';

/** A sub-agent's tool calls, which name the sub-agent that made them. */
const SUBAGENT_TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);

/**
 * Maps a Codex hook payload to a status update, or null when it says nothing
 * about status. Codex names its events and fields as Claude Code does, so the
 * shared mapping applies; only `Interrupt` (Esc, or a declined approval) is its
 * own, and it ends the turn without a `Stop`. A turn that fails runs no hook at
 * all; `codex-turn-watch.ts` covers that.
 */
export function mapCodexHookPayload(payload: unknown): AgentHookStatusUpdate | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const event = body.hook_event_name;
  if (event === 'Interrupt') return { state: 'done', event, detail: 'Interrupted' };
  // Codex runs it with the first prompt, just ahead of `UserPromptSubmit`: read as
  // Claude Code's "session ready", it would report a turn in flight as over.
  if (event === 'SessionStart') return null;
  // shortcut: a sub-agent's tool calls are dropped, since nothing here says when
  // it ends and a late one would hold a finished lead at `working`. Track Codex
  // sub-agents like `subagents.ts` does once their event order is recorded.
  if (typeof event === 'string' && SUBAGENT_TOOL_EVENTS.has(event) && body.agent_id !== undefined)
    return null;
  return mapClaudeHookPayload(payload);
}
