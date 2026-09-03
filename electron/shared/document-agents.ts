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
}

export const DOCUMENT_AGENT_SUPPORT: Record<string, DocumentAgentSupport> = {
  'claude-code': { headless: true, resume: true },
  codex: { headless: true, resume: true },
  gemini: { headless: true, resume: false },
  opencode: { headless: true, resume: false },
  copilot: { headless: true, resume: false },
};

export function documentAgentSupport(agentId: string): DocumentAgentSupport {
  return DOCUMENT_AGENT_SUPPORT[agentId] ?? { headless: false, resume: false };
}

/** Default agent for a project's main session. */
export const DEFAULT_DOCUMENT_MAIN_AGENT = 'claude-code';

/** Hard cap on candidates per run; each one is a worktree plus a CLI process. */
export const MAX_DOCUMENT_CANDIDATES = 6;
