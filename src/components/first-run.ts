import type { AgentDef } from '../../electron/ipc/shared-types';

/** Prompts that produce a reviewable diff on almost any repo, so the first
 *  task exercises the whole dispatch → review → merge loop. */
export const FIRST_TASK_SUGGESTIONS: ReadonlyArray<{ name: string; prompt: string }> = [
  {
    name: 'Map the architecture',
    prompt:
      'Explore this repository and write ARCHITECTURE.md: the main modules, how they depend on each other, and where a new contributor should start reading. Keep it under 150 lines.',
  },
  {
    name: 'Cover an untested module',
    prompt:
      'Find a module with real logic and little or no test coverage. Write focused unit tests for its public functions and make sure they pass.',
  },
  {
    name: 'Resolve stale TODOs',
    prompt:
      'List every TODO and FIXME comment in the codebase. Resolve the ones that are safe to fix in isolation and leave a one-line note on each one you skip and why.',
  },
];

/** One line describing which agent CLIs were found, or null when nothing is known yet. */
export function detectedAgentsLine(agents: ReadonlyArray<Pick<AgentDef, 'name' | 'available'>>) {
  const found = agents.filter((a) => a.available === true).map((a) => a.name);
  if (found.length > 0) return `Detected: ${found.join(', ')}`;
  if (agents.some((a) => a.available === false)) {
    return 'No agent CLI found on your PATH yet. Install Claude Code, Codex, or Gemini CLI.';
  }
  return null;
}
