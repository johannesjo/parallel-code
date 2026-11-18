import { mapCodexHookPayload } from './codex-status.js';
import { mapClaudeHookPayload, type AgentHookStatusUpdate } from './status.js';
import { createSubagentGate } from './subagents.js';
import { createToolCallMatcher } from './tool-calls.js';

export type HookSource = 'claude' | 'codex';

/** Maps one raw hook payload of a launch to a status update, or null to ignore it. */
export type HookPayloadMapper = (
  source: HookSource,
  launchId: string,
  payload: unknown,
) => AgentHookStatusUpdate | null;

/**
 * The stateful mapping from raw hook payloads to status updates, as the hook
 * server runs it. Recorded sessions replay through this same function, so a
 * test covers the sub-agent and tool-call tracking, not just the field mapping.
 */
export function createHookPayloadMapper(): HookPayloadMapper {
  const gateSubagents = createSubagentGate();
  const matchToolCalls = createToolCallMatcher();
  return (source, launchId, payload) =>
    // The gate follows Claude Code's background work, which Codex does not report.
    source === 'codex'
      ? mapCodexHookPayload(payload)
      : gateSubagents(
          launchId,
          payload,
          matchToolCalls(launchId, payload, mapClaudeHookPayload(payload)),
        );
}
