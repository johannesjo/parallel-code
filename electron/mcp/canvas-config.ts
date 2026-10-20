import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMcpLaunchArgs, isCodexCommand, type ParallelCodeMcpConfig } from './agent-args.js';
import { atomicWriteFileSync } from './atomic.js';
import { appendGitInfoExcludeBlock } from '../ipc/git-exclude.js';
import { getMCPRemoteServerUrl, sessionCapabilityArgs } from './config.js';
import type { SessionCapabilities } from '../shared/delegation-types.js';

/** Explicit MCP launch configuration belongs to the user (or coordinator). */
export function canConfigureCanvasMcp(command: string, args: string[]): boolean {
  return (
    ['claude', 'codex', 'copilot'].includes(path.basename(command)) &&
    !args.some(
      (arg) =>
        /^(--mcp-config|--additional-mcp-config|--strict-mcp-config)(=|$)/.test(arg) ||
        /^(?:(?:--config|-c)=)?mcp_servers(?:\.|\[|=)/.test(arg),
    )
  );
}

/** Config files hold the session token; track them so PTY exit and app quit can remove them.
 *  Docker sessions also get a copy of the server bundle inside the worktree. */
const configFiles = new Map<string, { configPath: string; bundlePath?: string }>();

function unlinkIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Only a regular file at the recorded path is removed; a link there is left alone. */
function unlinkRegularFile(file: string): void {
  try {
    if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function removeCanvasConfig(agentId: string): void {
  const entry = configFiles.get(agentId);
  if (!entry) return;
  configFiles.delete(agentId);
  unlinkIfPresent(entry.configPath);
  // Agents in the same worktree share one bundle; it goes with the last of them.
  const bundle = entry.bundlePath;
  if (bundle && ![...configFiles.values()].some((other) => other.bundlePath === bundle))
    unlinkRegularFile(bundle);
}

export function removeAllCanvasConfigs(): void {
  for (const agentId of [...configFiles.keys()]) {
    try {
      removeCanvasConfig(agentId);
    } catch (error) {
      console.warn('Could not remove canvas MCP credentials:', error);
    }
  }
}

/** Codex takes the config inline in argv, which any local process can read; keep the token in the 0600 file. */
function launchConfig(
  command: string,
  configPath: string,
  config: ParallelCodeMcpConfig,
): ParallelCodeMcpConfig {
  if (!isCodexCommand(command)) return config;
  const server = config.mcpServers['parallel-code'];
  return {
    mcpServers: {
      'parallel-code': { ...server, args: [...server.args, '--token-file', configPath], env: {} },
    },
  };
}

/** Ordinary sessions share the server binary with an explicit launch-time tool profile. */
export function prepareCanvasMcpArgs(opts: {
  command: string;
  taskId: string;
  agentId: string;
  cwd: string;
  serverPath: string;
  port: number;
  token: string;
  dockerMode?: boolean;
  sessionCapabilities?: SessionCapabilities;
}): string[] {
  for (const id of [opts.taskId, opts.agentId])
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid canvas session ID.');
  fs.accessSync(opts.serverPath, fs.constants.R_OK);
  let serverPath = opts.serverPath;
  let bundlePath: string | undefined;
  let directory = os.tmpdir();
  if (opts.dockerMode) {
    const excluded = appendGitInfoExcludeBlock(
      opts.cwd,
      '/.parallel-code/parallel-code-canvas-*.json',
      '/.parallel-code/parallel-code-canvas-*.json\n/.parallel-code/canvas-mcp-server.cjs\n',
    );
    if (excluded === 'failed')
      throw new Error('Could not exclude canvas MCP credentials from Git.');
    directory = path.join(fs.realpathSync(opts.cwd), '.parallel-code');
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error('MCP directory must not be a symbolic link.');
    serverPath = path.join(directory, 'canvas-mcp-server.cjs');
    atomicWriteFileSync(serverPath, fs.readFileSync(opts.serverPath, 'utf8'));
    bundlePath = serverPath;
  }
  const configPath = path.join(directory, `parallel-code-canvas-${opts.agentId}.json`);
  const config = {
    mcpServers: {
      'parallel-code': {
        command: 'node',
        args: [
          serverPath,
          '--url',
          getMCPRemoteServerUrl(opts.port, opts.dockerMode ? 'canvas' : undefined),
          '--task-id',
          opts.taskId,
          ...(opts.sessionCapabilities
            ? sessionCapabilityArgs(opts.sessionCapabilities)
            : ['--canvas-only']),
        ],
        env: { PARALLEL_CODE_MCP_TOKEN: opts.token },
      },
    },
  };
  atomicWriteFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  configFiles.set(opts.agentId, { configPath, bundlePath });
  return buildMcpLaunchArgs(
    opts.command,
    configPath,
    launchConfig(opts.command, configPath, config),
  );
}
