import { projectAgentEnv } from './project-env.js';
import { optionalWorktreeScript } from './worktree-scripts.js';

/**
 * Per-project worktree settings, pushed by the renderer (which owns project
 * state) when state loads and whenever a project's settings are saved.
 * Coordinator sub-tasks and delegation parents are created and closed here in
 * the main process, without a renderer round trip, so they read them from here.
 */
interface WorktreeSettings {
  teardownScript?: string;
  includes?: { name: string; mode: 'symlink' | 'copy' }[];
}
const settingsByProject = new Map<string, WorktreeSettings>();

// Before saved lists existed, sub-tasks always linked this. (`.claude` was listed
// too, but createWorktree never links it: every worktree gets its own.)
const DEFAULT_SUBTASK_SYMLINKS = ['node_modules'];

function validIncludes(raw: unknown): WorktreeSettings['includes'] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error('includes must be an array');
  return raw.map((entry: unknown) => {
    const { name, mode } = (entry ?? {}) as { name?: unknown; mode?: unknown };
    if (typeof name !== 'string' || (mode !== 'symlink' && mode !== 'copy'))
      throw new Error('includes entries need a name and a symlink or copy mode');
    return { name, mode };
  });
}

/** Replaces the project's settings; missing values clear them. Throws on invalid input and keeps the old ones. */
export function setProjectWorktreeSettings(
  projectId: string,
  raw: { teardownScript?: unknown; includes?: unknown },
): void {
  const settings: WorktreeSettings = {
    teardownScript: optionalWorktreeScript(raw.teardownScript, 'teardownScript'),
    includes: validIncludes(raw.includes),
  };
  if (settings.teardownScript || settings.includes) settingsByProject.set(projectId, settings);
  else settingsByProject.delete(projectId);
}

/** `deleteTask` options that run the project's teardown script, or none without one. */
export function projectTeardownOptions(projectId: string): {
  teardownScript?: string;
  teardownEnv?: Record<string, string>;
} {
  const teardownScript = settingsByProject.get(projectId)?.teardownScript;
  return teardownScript ? { teardownScript, teardownEnv: projectAgentEnv(projectId) } : {};
}

/** Git-ignored entries a new sub-task worktree brings in, as the project saved them. */
export function projectWorktreeDirs(projectId: string): {
  symlinkDirs: string[];
  copyDirs: string[];
} {
  const includes = settingsByProject.get(projectId)?.includes;
  if (!includes) return { symlinkDirs: [...DEFAULT_SUBTASK_SYMLINKS], copyDirs: [] };
  const pick = (mode: 'symlink' | 'copy') =>
    includes.filter((entry) => entry.mode === mode).map((entry) => entry.name);
  return { symlinkDirs: pick('symlink'), copyDirs: pick('copy') };
}
