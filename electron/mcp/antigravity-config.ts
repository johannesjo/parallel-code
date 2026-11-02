import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic.js';
import type { ParallelCodeMcpConfig } from './agent-args.js';
import { appendGitInfoExcludeBlock } from '../ipc/git-exclude.js';

/**
 * Antigravity has no MCP launch flag; it reads servers from this workspace file.
 * agy 1.4.6's built-in docs allow `mcp_config.json` in a workspace `.agents/` root,
 * but its MCP page names only global and plugin configs. If a release ignores this
 * file, `.agents/plugins/parallel-code/` (with a `plugin.json`) is the documented home.
 */
export const ANTIGRAVITY_MCP_CONFIG = '.agents/mcp_config.json';

/** Creates the config's parent directory. A linked `.agents` could put the token in another checkout. */
function ensureAntigravityConfigDir(workspace: string): void {
  const dir = path.join(workspace, '.agents');
  // Not recursive: a workspace that is gone must fail, not be recreated.
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('.agents must not be a symbolic link.');
}

/** The file holds a session token: keep it out of `git status` and so out of agent commits. */
function excludeAntigravityConfig(workspace: string): void {
  const result = appendGitInfoExcludeBlock(
    workspace,
    `/${ANTIGRAVITY_MCP_CONFIG}`,
    `# Parallel Code Antigravity MCP config (contains ephemeral token)\n/${ANTIGRAVITY_MCP_CONFIG}\n`,
  );
  if (result === 'failed') throw new Error(`Could not exclude ${ANTIGRAVITY_MCP_CONFIG} from Git.`);
}

function isTracked(workspace: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', ANTIGRAVITY_MCP_CONFIG], {
      cwd: workspace,
      stdio: 'ignore',
      timeout: 3000,
    });
    return true;
  } catch (err) {
    // Exit 1 means untracked. Anything else (no repo, no git, timeout) is no answer:
    // fail closed rather than risk writing the token into a tracked file.
    if ((err as { status?: unknown }).status === 1) return false;
    throw new Error(`Could not check whether ${ANTIGRAVITY_MCP_CONFIG} is tracked: ${String(err)}`);
  }
}

/**
 * Makes `workspace` safe to hold the token file: refuses a tracked file or a linked
 * `.agents`, creates the directory and excludes the file from Git.
 */
export function prepareAntigravityConfigDir(workspace: string): void {
  if (isTracked(workspace))
    throw new Error(
      `${ANTIGRAVITY_MCP_CONFIG} is tracked by Git; a commit would publish its MCP token.`,
    );
  ensureAntigravityConfigDir(workspace);
  excludeAntigravityConfig(workspace);
}

function readServers(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const content = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: unknown };
  const servers = content.mcpServers;
  return servers && typeof servers === 'object' ? (servers as Record<string, unknown>) : {};
}

/**
 * Gives a sub-task's agy session the Parallel Code server. A child's worktree is its own,
 * so the file is merged in place and goes with the worktree; nothing is restored.
 */
export function writeAntigravityMcpConfig(workspace: string, config: ParallelCodeMcpConfig): void {
  prepareAntigravityConfigDir(workspace);
  const file = path.join(workspace, ANTIGRAVITY_MCP_CONFIG);
  const mcpServers = { ...readServers(file), ...config.mcpServers };
  atomicWriteFileSync(file, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
}
