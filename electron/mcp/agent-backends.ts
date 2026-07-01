export const AGENT_BACKENDS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'copilot',
  'antigravity',
] as const;

export type AgentBackend = (typeof AGENT_BACKENDS)[number];

export function isAgentBackend(value: unknown): value is AgentBackend {
  return typeof value === 'string' && AGENT_BACKENDS.some((backend) => backend === value);
}
