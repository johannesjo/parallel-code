/**
 * Which built-in agents can run a document proposal headlessly, and whether
 * the CLI can resume a previous session (needed for the warm main session).
 * Renderer-safe: no Node or Electron imports.
 */
export interface DocumentAgentSupport {
  /** The CLI has a non-interactive mode the runner knows how to drive. */
  headless: boolean;
  /** The CLI can resume a session by id in that mode. */
  resume: boolean;
  /** Model names the CLI is known to accept, offered as suggestions; any name it takes works. */
  models: readonly string[];
  /** Reasoning levels the CLI accepts, lowest first; empty when it has no such flag. */
  efforts: readonly string[];
}

/**
 * Only CLIs whose headless mode can be kept away from the canonical checkout
 * are listed: Claude Code runs with file tools only, Codex inside its
 * workspace-write sandbox (writes outside the worktree are blocked), Gemini
 * with edits auto-approved and shell commands needing an approval that a
 * non-interactive run cannot give. OpenCode and Copilot expose a full shell
 * in print mode and stay out until they can be restricted.
 */
export const DOCUMENT_AGENT_SUPPORT: Record<string, DocumentAgentSupport> = {
  'claude-code': {
    headless: true,
    resume: true,
    // Aliases resolve to the latest model of each tier, so they do not go stale.
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  codex: {
    headless: true,
    resume: true,
    models: [],
    // Which of these a model takes varies by model; the CLI rejects the rest.
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  gemini: { headless: true, resume: false, models: [], efforts: [] },
};

const NO_SUPPORT: DocumentAgentSupport = {
  headless: false,
  resume: false,
  models: [],
  efforts: [],
};

export function documentAgentSupport(agentId: string): DocumentAgentSupport {
  return DOCUMENT_AGENT_SUPPORT[agentId] ?? NO_SUPPORT;
}

/** Default agent for a project's main session. */
export const DEFAULT_DOCUMENT_MAIN_AGENT = 'claude-code';

/** Hard cap on candidates per run; each one is a worktree plus a CLI process. */
export const MAX_DOCUMENT_CANDIDATES = 6;
