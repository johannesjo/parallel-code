interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  description: string;
}

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: [],
    resume_args: ["--continue"],
    description: "Anthropic's Claude Code CLI agent",
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    args: [],
    resume_args: ["resume", "--last"],
    description: "OpenAI's Codex CLI agent",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    args: [],
    resume_args: ["--resume", "latest"],
    description: "Google's Gemini CLI agent",
  },
];

export function listAgents(): AgentDef[] {
  return DEFAULT_AGENTS;
}
