/** Inputs the live-map activation decision needs; the host reads them from the store. */
export interface ActivationInput {
  hasSource: boolean;
  agentStatus?: 'running' | 'exited';
  /** Undefined until the spawn reports whether canvas MCP tools were configured. */
  canvasTools?: boolean;
  closing: boolean;
  awaitingInitialPrompt: boolean;
  hookState?: string;
  askingQuestion: boolean;
  terminalInputPending: boolean;
  idle: boolean;
}

export const CANVAS_TOOLS_UNAVAILABLE =
  'Canvas tools are unavailable in this session. Start a Claude Code, Codex, or Copilot session with canvas MCP enabled.';
export const CANVAS_TOOLS_PENDING = 'Checking session tools…';

export type ActivationCanvas = 'reasoning' | 'mindmap';

/** Why the prompt cannot be sent right now; empty when the agent is ready. */
export function activationBlocker(
  input: ActivationInput,
  canvas: ActivationCanvas = 'reasoning',
): string {
  const mindmap = canvas === 'mindmap';
  if (!input.hasSource) return 'No agent session available for this task.';
  if (input.agentStatus !== 'running')
    return mindmap
      ? 'Start the agent before sending changes.'
      : 'Start the agent to use the live map.';
  if (input.canvasTools === undefined) return CANVAS_TOOLS_PENDING;
  if (!input.canvasTools) return CANVAS_TOOLS_UNAVAILABLE;
  if (input.closing) return 'This task is closing.';
  if (input.awaitingInitialPrompt) return 'Waiting for the task’s initial prompt to be sent.';
  if (input.hookState === 'waiting' || input.askingQuestion)
    return 'Answer or dismiss the question in the agent terminal first.';
  if (input.terminalInputPending)
    return 'Submit or clear the unsent input in the agent terminal first.';
  if (input.hookState === 'working') return 'The agent is still working.';
  if (!input.idle)
    return mindmap
      ? 'Wait until the agent is idle.'
      : 'The agent is working; the live map will start when it is ready.';
  return '';
}

/** Whether a queued request can still wait: the session exists, is alive, and tools are not ruled out.
 *  Unknown tools keep waiting so a request queued across an agent restart survives the spawn. */
export function canQueueActivation(input: ActivationInput): boolean {
  return (
    input.hasSource &&
    input.agentStatus === 'running' &&
    input.canvasTools !== false &&
    !input.closing
  );
}
