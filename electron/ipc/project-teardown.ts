import { projectAgentEnv } from './project-env.js';
import { optionalWorktreeScript } from './worktree-scripts.js';

/**
 * Per-project worktree teardown scripts, pushed by the renderer (which owns
 * project state) when state loads and whenever a project's settings are saved.
 * Coordinator sub-tasks and delegation parents are closed here in the main
 * process, without a renderer round trip, so they read the script from here.
 */
const teardownScripts = new Map<string, string>();

/** Stores the project's script; an empty or missing one clears it. Throws on invalid input. */
export function setProjectTeardownScript(projectId: string, script: unknown): void {
  const clean = optionalWorktreeScript(script, 'teardownScript');
  if (clean) teardownScripts.set(projectId, clean);
  else teardownScripts.delete(projectId);
}

/** `deleteTask` options that run the project's teardown script, or none without one. */
export function projectTeardownOptions(projectId: string): {
  teardownScript?: string;
  teardownEnv?: Record<string, string>;
} {
  const teardownScript = teardownScripts.get(projectId);
  return teardownScript ? { teardownScript, teardownEnv: projectAgentEnv(projectId) } : {};
}
