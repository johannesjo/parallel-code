import { sanitizeEnvVars } from '../shared/env-vars.js';
import { expandHome } from './env-file.js';

/**
 * Per-project agent environment, pushed by the renderer (which owns project
 * state) when state loads and whenever a project's settings are saved. Spawns
 * receive only a project id, so the values, which may be secrets, never travel
 * in spawn arguments, and coordinator sub-tasks spawned here in the main
 * process get the same variables as tasks the renderer starts.
 */
const projectEnvs = new Map<string, Record<string, string>>();

export function setProjectAgentEnv(projectId: string, env: unknown): void {
  const clean = sanitizeEnvVars(env);
  if (clean) projectEnvs.set(projectId, clean);
  else projectEnvs.delete(projectId);
}

/** The project's variables, with a leading `~` in each value expanded to the
 *  home directory, so `CLAUDE_CONFIG_DIR=~/.claude-work` works as written. */
export function projectAgentEnv(projectId: string | undefined): Record<string, string> {
  const env = projectId ? projectEnvs.get(projectId) : undefined;
  if (!env) return {};
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expandHome(value)]));
}
