import type { ChatDecision, ChatRequest } from '../shared/agent-chat-types.js';

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');

const FORM_MODES = new Set(['form', 'openai/form', 'openaiForm']);

/**
 * Reads `mcpServer/elicitation/request` as an approval card. Codex sends MCP tool-call
 * approvals as a form with no fields. Returns undefined for anything else.
 */
// shortcut: forms with fields and URL elicitations are cancelled — map fields to question
// cards (needing Decline and optional fields) and open URLs on Accept if servers need them.
export function readElicitation(id: string | number, params: RecordValue): ChatRequest | undefined {
  const message = string(params.message);
  const base = {
    id,
    since: Date.now(),
    kind: 'approval' as const,
    action: `MCP ${string(params.serverName) || 'server'}`,
  };
  if (!FORM_MODES.has(string(params.mode))) return undefined;
  if (Object.keys(record(record(params.requestedSchema).properties)).length) return undefined;
  const toolParams = record(params._meta).tool_params;
  return {
    ...base,
    text: message || 'Allow this MCP request?',
    details: toolParams === undefined ? undefined : JSON.stringify(toolParams, null, 2),
  };
}

/** The `McpServerElicitationRequestResponse` for the user's decision on the card. */
export function elicitationResult(decision: ChatDecision): RecordValue {
  return decision === 'decline' ? { action: 'decline' } : { action: 'accept', content: {} };
}
