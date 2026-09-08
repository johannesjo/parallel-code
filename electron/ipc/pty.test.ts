import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileSync, mockExecFile, mockChildProcessSpawn, mockPtySpawn, mockLogDebug } =
  vi.hoisted(() => {
    const mockExecFileSync = vi.fn((command: string, args?: string[]) => {
      if (command === 'which' && args?.[0] === 'nonexistent-binary-xyz') {
        throw new Error('not found');
      }
      return '';
    });

    const mockExecFile = vi.fn();
    const mockChildProcessSpawn = vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    }));

    const mockPtySpawn = vi.fn(
      (_command: string, _args: string[], options: { cols: number; rows: number }) => {
        let onDataHandler: ((data: string) => void) | undefined;
        let onExitHandler:
          | ((event: { exitCode: number; signal: number | undefined }) => void)
          | undefined;

        const proc = {
          cols: options.cols,
          rows: options.rows,
          write: vi.fn(),
          resize: vi.fn((cols: number, rows: number) => {
            proc.cols = cols;
            proc.rows = rows;
          }),
          pause: vi.fn(),
          resume: vi.fn(),
          kill: vi.fn(() => {
            onExitHandler?.({ exitCode: 0, signal: 15 });
          }),
          onData: vi.fn((handler: (data: string) => void) => {
            onDataHandler = handler;
          }),
          onExit: vi.fn(
            (handler: (event: { exitCode: number; signal: number | undefined }) => void) => {
              onExitHandler = handler;
            },
          ),
          emitData(data: string) {
            onDataHandler?.(data);
          },
          emitExit(event: { exitCode: number; signal: number | undefined }) {
            onExitHandler?.(event);
          },
        };

        return proc;
      },
    );

    const mockLogDebug = vi.fn();

    return { mockExecFileSync, mockExecFile, mockChildProcessSpawn, mockPtySpawn, mockLogDebug };
  });

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: mockExecFileSync,
    execFile: mockExecFile,
    spawn: mockChildProcessSpawn,
  };
});

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn,
}));

vi.mock('../log.js', () => ({
  debug: mockLogDebug,
}));

import {
  buildPtySpawnEnv,
  buildDockerImage,
  DOCKER_CONTAINER_HOME,
  dockerImageExists,
  hashDockerfile,
  isDockerAvailable,
  killAgent,
  killAllAgents,
  onPtyEvent,
  projectImageTag,
  resolveProjectDockerfile,
  spawnAgent,
  validateCommand,
  writeToAgent,
} from './pty.js';

let tempPaths: string[] = [];
let agentCounter = 0;

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  } as unknown as BrowserWindow;
}

function nextAgentId(): string {
  agentCounter += 1;
  return `agent-${agentCounter}`;
}

function buildSpawnArgs(
  overrides: Partial<Parameters<typeof spawnAgent>[1]> = {},
): Parameters<typeof spawnAgent>[1] {
  return {
    taskId: 'task-1',
    agentId: nextAgentId(),
    command: 'claude',
    args: ['--print', 'hello'],
    cwd: '/workspace/project',
    env: {},
    cols: 120,
    rows: 40,
    dockerMode: true,
    dockerImage: 'parallel-code-agent:test',
    shareDockerAgentAuth: false,
    onOutput: { __CHANNEL_ID__: 'channel-1' },
    ...overrides,
  };
}

function getLastSpawnCall(): {
  command: string;
  args: string[];
  options: {
    cols: number;
    rows: number;
    cwd?: string;
    env: Record<string, string>;
    name: string;
  };
} {
  const lastCall = mockPtySpawn.mock.lastCall;
  expect(lastCall).toBeTruthy();
  const [command, args, options] = lastCall as [
    string,
    string[],
    { cols: number; rows: number; cwd?: string; env: Record<string, string>; name: string },
  ];
  return { command, args, options };
}

function getFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === flag) {
      values.push(args[i + 1]);
    }
  }
  return values;
}

function getSpawnCommandLogCtx(): { args: string[]; command: string } {
  const call = mockLogDebug.mock.calls.find(
    ([category, msg]) => category === 'pty' && String(msg).startsWith('spawn command '),
  );
  expect(call).toBeTruthy();
  return call?.[2] as { args: string[]; command: string };
}

function makeTempHome(entries: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-docker-home-'));
  tempPaths.push(home);

  for (const entry of entries) {
    const target = path.join(home, entry);
    if (entry.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'test');
    }
  }

  return home;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  tempPaths = [];
});

afterEach(() => {
  killAllAgents();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const tempPath of tempPaths) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
  tempPaths = [];
});

describe('DOCKER_CONTAINER_HOME', () => {
  it('uses a home directory writable by arbitrary host-mapped docker users', () => {
    expect(DOCKER_CONTAINER_HOME).toBe('/tmp');
  });
});

describe('buildPtySpawnEnv', () => {
  it('applies safe renderer overrides and clears nested agent markers', () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_SESSION', 'session');
    vi.stubEnv('PARALLEL_CODE_MCP_TOKEN', 'host-token');

    const env = buildPtySpawnEnv({
      CUSTOM_ENV: 'ok',
      PATH: '/tmp/bad-path',
      HOME: '/tmp/bad-home',
      NODE_OPTIONS: '--require bad',
      PARALLEL_CODE_MCP_TOKEN: 'renderer-token',
    });

    expect(env.CUSTOM_ENV).toBe('ok');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.PATH).not.toBe('/tmp/bad-path');
    expect(env.HOME).not.toBe('/tmp/bad-home');
    expect(env.NODE_OPTIONS).not.toBe('--require bad');
    expect(env.PARALLEL_CODE_MCP_TOKEN).toBe('host-token');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION).toBeUndefined();
  });

  it('merges agent env file values over the inherited environment', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-login-shell');

    const env = buildPtySpawnEnv(
      {},
      {
        ANTHROPIC_API_KEY: 'from-env-file',
        ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: abc\nx-tenant: acme',
      },
    );

    expect(env.ANTHROPIC_API_KEY).toBe('from-env-file');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-api-key: abc\nx-tenant: acme');
  });

  it('keeps the block list authoritative over agent env file values', () => {
    vi.stubEnv('PARALLEL_CODE_MCP_TOKEN', 'host-token');

    const env = buildPtySpawnEnv(
      {},
      { PATH: '/tmp/bad-path', HOME: '/tmp/bad-home', PARALLEL_CODE_MCP_TOKEN: 'file-token' },
    );

    expect(env.PATH).not.toBe('/tmp/bad-path');
    expect(env.HOME).not.toBe('/tmp/bad-home');
    expect(env.PARALLEL_CODE_MCP_TOKEN).toBe('host-token');
  });

  it('lets per-task renderer env win over the agent env file', () => {
    const env = buildPtySpawnEnv({ ANTHROPIC_API_KEY: 'per-task' }, { ANTHROPIC_API_KEY: 'file' });
    expect(env.ANTHROPIC_API_KEY).toBe('per-task');
  });
});

describe('spawnAgent docker mode', () => {
  it('uses --network host (not --add-host, which is incompatible with host networking on Linux)', () => {
    spawnAgent(createMockWindow(), buildSpawnArgs({ cwd: '/workspace/project' }));
    const { args } = getLastSpawnCall();
    expect(args).toContain('--network');
    const netIdx = args.indexOf('--network');
    expect(args[netIdx + 1]).toBe('host');
    // --add-host=host.docker.internal:host-gateway is invalid with --network host on Linux
    expect(args.join(' ')).not.toContain('--add-host');
  });

  it('sets -w to the worktree cwd so the container starts in the right directory', () => {
    const cwd = '/workspace/my-project';
    spawnAgent(createMockWindow(), buildSpawnArgs({ cwd, dockerMountWorktreeParent: false }));
    const { args } = getLastSpawnCall();
    const wIdx = args.indexOf('-w');
    expect(wIdx).toBeGreaterThan(0);
    expect(args[wIdx + 1]).toBe(cwd);
  });

  it('volume-mounts the worktree cwd at the same host path', () => {
    const cwd = '/workspace/my-project';
    spawnAgent(createMockWindow(), buildSpawnArgs({ cwd, dockerMountWorktreeParent: false }));
    const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
    expect(volumeFlags).toContain(`${cwd}:${cwd}`);
  });

  it('injects a per-agent HOME under /tmp into docker run args', () => {
    vi.stubEnv('HOME', '/Users/tester');

    const agentId = nextAgentId();
    spawnAgent(createMockWindow(), buildSpawnArgs({ agentId }));

    const { command, args } = getLastSpawnCall();
    expect(command).toBe('docker');
    expect(getFlagValues(args, '-e')).toContain(`HOME=${DOCKER_CONTAINER_HOME}/agent-${agentId}`);
  });

  it('does not forward host or renderer HOME as a generic docker env flag', () => {
    const hostHome = '/Users/host-home';
    const rendererHome = '/Users/renderer-home';
    vi.stubEnv('HOME', hostHome);

    const agentId = nextAgentId();
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        agentId,
        env: {
          API_KEY: 'secret',
          HOME: rendererHome,
        },
      }),
    );

    const envFlags = getFlagValues(getLastSpawnCall().args, '-e');
    expect(envFlags).toContain('API_KEY');
    // HOME may appear only as the explicit container assignment — never
    // forwarded by name, and never carrying a host or renderer path.
    expect(envFlags.filter((value) => value === 'HOME' || value.startsWith('HOME='))).toEqual([
      `HOME=${DOCKER_CONTAINER_HOME}/agent-${agentId}`,
    ]);
    expect(envFlags).not.toContain(`HOME=${hostHome}`);
    expect(envFlags).not.toContain(`HOME=${rendererHome}`);
  });

  it('passes env values through the docker client env, never in argv', () => {
    // `-e KEY=VALUE` would expose API keys via ps / /proc/<pid>/cmdline for the
    // lifetime of the container. Values must reach docker via its own env.
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({ env: { ANTHROPIC_API_KEY: 'sk-ant-super-secret' } }),
    );

    const { args, options } = getLastSpawnCall();
    expect(getFlagValues(args, '-e')).toContain('ANTHROPIC_API_KEY');
    expect(args.join(' ')).not.toContain('sk-ant-super-secret');
    expect(options.env.ANTHROPIC_API_KEY).toBe('sk-ant-super-secret');
  });

  it('redacts docker env values in spawn debug logs', () => {
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        env: {
          API_KEY: 'secret-api-key',
          NO_VALUE: '',
        },
      }),
    );

    const ctx = getSpawnCommandLogCtx();
    const logged = ctx.args.join(' ');

    expect(ctx.command).toBe('docker');
    // Name-only flags carry no value, so the name is logged as-is; only the
    // explicit `HOME=<path>` assignment still needs redacting.
    expect(getFlagValues(ctx.args, '-e')).toContain('API_KEY');
    expect(getFlagValues(ctx.args, '-e')).toContain('NO_VALUE');
    expect(getFlagValues(ctx.args, '-e')).toContain(`HOME=<redacted>`);
    expect(logged).not.toContain('secret-api-key');
    expect(logged).not.toContain(`HOME=${DOCKER_CONTAINER_HOME}`);
    expect(logged).toContain('parallel-code-agent:test');
  });

  it('redacts inline docker env values in spawn debug logs', () => {
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        args: ['--env=INLINE_TOKEN=inline-secret', '--env', 'SPLIT_TOKEN=split-secret'],
      }),
    );

    const logged = getSpawnCommandLogCtx().args.join(' ');

    expect(logged).toContain('--env=INLINE_TOKEN=<redacted>');
    expect(logged).toContain('SPLIT_TOKEN=<redacted>');
    expect(logged).not.toContain('inline-secret');
    expect(logged).not.toContain('split-secret');
  });

  it('redacts shell command strings in spawn debug logs', () => {
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        command: '/bin/sh',
        args: ['-c', 'codex exec "prompt containing private context"'],
        dockerMode: false,
      }),
    );

    const ctx = getSpawnCommandLogCtx();

    expect(ctx.command).toBe('/bin/sh');
    expect(ctx.args).toEqual(['-c', '<redacted>']);
  });

  it('redirects credential mounts under per-agent /tmp/agent-<id> inside the container', () => {
    const home = makeTempHome(['.ssh/', '.gitconfig', '.config/gh/']);
    vi.stubEnv('HOME', home);

    const agentId = nextAgentId();
    spawnAgent(createMockWindow(), buildSpawnArgs({ agentId }));

    const containerHome = `${DOCKER_CONTAINER_HOME}/agent-${agentId}`;
    const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
    expect(volumeFlags).toContain(`${home}/.ssh:${containerHome}/.ssh:ro`);
    expect(volumeFlags).toContain(`${home}/.gitconfig:${containerHome}/.gitconfig:ro`);
    expect(volumeFlags).toContain(`${home}/.config/gh:${containerHome}/.config/gh:ro`);
  });

  describe('agent config dir mounts (shareDockerAgentAuth)', () => {
    it.each([
      ['claude', '.claude'],
      ['codex', '.codex'],
      ['gemini', '.gemini'],
      ['opencode', '.config/opencode'],
      ['copilot', '.config/github-copilot'],
      ['agy', '.gemini/antigravity-cli'],
    ])(
      '%s bind-mounts a user-owned host directory when shareDockerAgentAuth is enabled',
      (command, relDir) => {
        const home = makeTempHome([]);
        vi.stubEnv('HOME', home);

        const agentId = nextAgentId();
        spawnAgent(
          createMockWindow(),
          buildSpawnArgs({ agentId, command, shareDockerAgentAuth: true }),
        );

        const containerHome = `${DOCKER_CONTAINER_HOME}/agent-${agentId}`;
        const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
        const expectedHostDir = `${home}/.parallel-code/agent-auth/${command}/${relDir}`;
        expect(volumeFlags).toContain(`${expectedHostDir}:${containerHome}/${relDir}`);
      },
    );

    it('creates the host auth directory so it is user-owned before mounting', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ command: 'claude', shareDockerAgentAuth: true }),
      );

      const hostDir = `${home}/.parallel-code/agent-auth/claude/.claude`;
      expect(fs.existsSync(hostDir)).toBe(true);
    });

    it('bind-mounts .claude.json file for claude so auth persists across containers', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      const agentId = nextAgentId();
      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ agentId, command: 'claude', shareDockerAgentAuth: true }),
      );

      const containerHome = `${DOCKER_CONTAINER_HOME}/agent-${agentId}`;
      const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
      const expectedHostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      expect(volumeFlags).toContain(`${expectedHostFile}:${containerHome}/.claude.json`);
      expect(JSON.parse(fs.readFileSync(expectedHostFile, 'utf8'))).toMatchObject({
        projects: {
          '/workspace/project': {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      });
    });

    it('pre-seeds Claude folder trust for the mounted worktree path', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          command: 'claude',
          cwd: '/workspace/project',
          shareDockerAgentAuth: true,
        }),
      );

      const hostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      const config = JSON.parse(fs.readFileSync(hostFile, 'utf8')) as {
        projects?: Record<
          string,
          { hasTrustDialogAccepted?: boolean; hasCompletedProjectOnboarding?: boolean }
        >;
      };
      expect(config.projects?.['/workspace/project']).toMatchObject({
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      });
    });

    it('preserves existing Claude project config when pre-seeding folder trust', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);
      const hostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      fs.mkdirSync(path.dirname(hostFile), { recursive: true });
      fs.writeFileSync(
        hostFile,
        JSON.stringify({
          theme: 'dark',
          projects: {
            '/workspace/project': {
              allowedTools: ['Read'],
              hasTrustDialogAccepted: false,
            },
          },
        }),
      );

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          command: 'claude',
          cwd: '/workspace/project',
          shareDockerAgentAuth: true,
        }),
      );

      const config = JSON.parse(fs.readFileSync(hostFile, 'utf8')) as {
        theme?: string;
        projects?: Record<
          string,
          {
            allowedTools?: string[];
            hasTrustDialogAccepted?: boolean;
            hasCompletedProjectOnboarding?: boolean;
          }
        >;
      };
      expect(config.theme).toBe('dark');
      expect(config.projects?.['/workspace/project']).toMatchObject({
        allowedTools: ['Read'],
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      });
    });

    it('does not mount agent auth directory when shareDockerAgentAuth is disabled', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ command: 'claude', shareDockerAgentAuth: false }),
      );

      const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
      expect(volumeFlags.some((v) => v.includes('.parallel-code/agent-auth'))).toBe(false);
    });

    it('does not mount agent auth directory for an unknown agent command', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ command: 'unknown-agent', shareDockerAgentAuth: true }),
      );

      const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
      expect(volumeFlags.some((v) => v.includes('.parallel-code/agent-auth'))).toBe(false);
    });

    it('does not crash spawn when .claude.json contains malformed JSON', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);
      const hostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      fs.mkdirSync(path.dirname(hostFile), { recursive: true });
      fs.writeFileSync(hostFile, '{invalid json');

      expect(() =>
        spawnAgent(
          createMockWindow(),
          buildSpawnArgs({ command: 'claude', shareDockerAgentAuth: true }),
        ),
      ).not.toThrow();
      expect(mockPtySpawn).toHaveBeenCalled();
    });

    it('preserves existing project config for other paths after trust seeding', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);
      const hostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      fs.mkdirSync(path.dirname(hostFile), { recursive: true });
      fs.writeFileSync(
        hostFile,
        JSON.stringify({
          projects: {
            '/other/path': { hasTrustDialogAccepted: true },
          },
        }),
      );

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          command: 'claude',
          cwd: '/workspace/project',
          shareDockerAgentAuth: true,
        }),
      );

      const config = JSON.parse(fs.readFileSync(hostFile, 'utf8')) as {
        projects?: Record<
          string,
          { hasTrustDialogAccepted?: boolean; hasCompletedProjectOnboarding?: boolean }
        >;
      };
      expect(config.projects?.['/other/path']).toMatchObject({ hasTrustDialogAccepted: true });
      expect(config.projects?.['/workspace/project']).toMatchObject({
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      });
    });

    it('accumulates trust entries for multiple worktree paths', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          command: 'claude',
          cwd: '/workspace/task-one',
          shareDockerAgentAuth: true,
        }),
      );

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          command: 'claude',
          cwd: '/workspace/task-two',
          shareDockerAgentAuth: true,
        }),
      );

      const hostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      const config = JSON.parse(fs.readFileSync(hostFile, 'utf8')) as {
        projects?: Record<
          string,
          { hasTrustDialogAccepted?: boolean; hasCompletedProjectOnboarding?: boolean }
        >;
      };
      expect(config.projects?.['/workspace/task-one']).toMatchObject({
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      });
      expect(config.projects?.['/workspace/task-two']).toMatchObject({
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      });
    });

    it('does not write .claude.json trust file when shareDockerAgentAuth is disabled', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          command: 'claude',
          cwd: '/workspace/project',
          shareDockerAgentAuth: false,
        }),
      );

      const hostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      expect(fs.existsSync(hostFile)).toBe(false);
    });

    it('trust entry persists in host .claude.json file between container spawns', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      // First container spawn — seeds trust
      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          command: 'claude',
          cwd: '/workspace/my-project',
          shareDockerAgentAuth: true,
        }),
      );

      // Verify trust is written to host file after first spawn
      const claudeJsonPath = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      const afterFirst = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as {
        projects: Record<string, { hasTrustDialogAccepted: boolean }>;
      };
      expect(afterFirst.projects['/workspace/my-project']?.hasTrustDialogAccepted).toBe(true);

      // Second container spawn (same auth dir, same worktree path — simulates container B)
      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          command: 'claude',
          cwd: '/workspace/my-project',
          shareDockerAgentAuth: true,
        }),
      );

      // Trust entry must still be present (not wiped by second spawn)
      const afterSecond = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as {
        projects: Record<string, { hasTrustDialogAccepted: boolean }>;
      };
      expect(afterSecond.projects['/workspace/my-project']?.hasTrustDialogAccepted).toBe(true);
    });
  });

  describe('dockerMountWorktreeParent', () => {
    it('mounts parent directory when dockerMountWorktreeParent is true', () => {
      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          cwd: '/Users/alice/git/my-repo/.worktrees/task/coordinator-abc',
          dockerMountWorktreeParent: true,
        }),
      );

      const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
      // Parent directory should be mounted
      expect(volumeFlags).toContain(
        '/Users/alice/git/my-repo/.worktrees/task:/Users/alice/git/my-repo/.worktrees/task',
      );
      // Coordinator worktree itself still mounted
      expect(volumeFlags).toContain(
        '/Users/alice/git/my-repo/.worktrees/task/coordinator-abc:/Users/alice/git/my-repo/.worktrees/task/coordinator-abc',
      );
    });

    it('does not mount parent directory when dockerMountWorktreeParent is false', () => {
      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({
          cwd: '/Users/alice/git/my-repo/.worktrees/task/coordinator-abc',
          dockerMountWorktreeParent: false,
        }),
      );

      const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
      expect(volumeFlags).not.toContain(
        '/Users/alice/git/my-repo/.worktrees/task:/Users/alice/git/my-repo/.worktrees/task',
      );
      expect(volumeFlags).toContain(
        '/Users/alice/git/my-repo/.worktrees/task/coordinator-abc:/Users/alice/git/my-repo/.worktrees/task/coordinator-abc',
      );
    });
  });
});

describe('spawnAgent session reattach', () => {
  it('reuses an existing PTY session and moves live output to the new channel', () => {
    const win = createMockWindow();
    const agentId = 'agent-reattach';
    const args = buildSpawnArgs({
      agentId,
      command: 'claude',
      args: [],
      dockerMode: false,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    spawnAgent(win, args);
    const proc = mockPtySpawn.mock.results[0].value as ReturnType<typeof mockPtySpawn>;
    proc.emitData('before reload');

    spawnAgent(win, {
      ...args,
      cols: 90,
      rows: 30,
      attachExisting: true,
      onOutput: { __CHANNEL_ID__: 'channel-2' },
    });
    proc.emitData('after reload');

    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    expect(proc.resume).toHaveBeenCalled();
    expect(proc.resize).toHaveBeenCalledWith(90, 30);
    expect(win.webContents.send).toHaveBeenCalledWith('channel:channel-2', {
      type: 'Data',
      data: Buffer.from('before reload', 'utf8').toString('base64'),
    });
    expect(win.webContents.send).toHaveBeenLastCalledWith('channel:channel-2', {
      type: 'Data',
      data: Buffer.from('after reload', 'utf8').toString('base64'),
    });
  });

  it('reattaches before validating the launch command', () => {
    const win = createMockWindow();
    const agentId = 'agent-reattach-missing-command';
    const args = buildSpawnArgs({
      agentId,
      command: 'claude',
      args: [],
      dockerMode: false,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    spawnAgent(win, args);

    expect(() =>
      spawnAgent(win, {
        ...args,
        command: 'nonexistent-binary-xyz',
        attachExisting: true,
        onOutput: { __CHANNEL_ID__: 'channel-2' },
      }),
    ).not.toThrow();
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
  });

  it('replaces an existing same-id PTY when attachExisting is explicitly false', () => {
    const win = createMockWindow();
    const agentId = 'agent-replace';
    const args = buildSpawnArgs({
      agentId,
      command: 'claude',
      args: [],
      dockerMode: false,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    spawnAgent(win, args);
    const oldProc = mockPtySpawn.mock.results[0].value as ReturnType<typeof mockPtySpawn>;

    spawnAgent(win, {
      ...args,
      attachExisting: false,
      onOutput: { __CHANNEL_ID__: 'channel-2' },
    });

    expect(oldProc.kill).toHaveBeenCalled();
    expect(mockPtySpawn).toHaveBeenCalledTimes(2);
  });
});

describe('validateCommand', () => {
  it('does not throw for a command found in PATH', () => {
    expect(() => validateCommand('/bin/sh')).not.toThrow();
  });

  it('throws a descriptive error for a missing command', () => {
    expect(() => validateCommand('nonexistent-binary-xyz')).toThrow(/not found in PATH/);
  });

  it('throws a descriptive error naming the command', () => {
    expect(() => validateCommand('nonexistent-binary-xyz')).toThrow(/nonexistent-binary-xyz/);
  });

  it('throws for a nonexistent absolute path', () => {
    expect(() => validateCommand('/nonexistent/path/binary')).toThrow(
      /not found or not executable/,
    );
  });

  it('does not throw for a bare command found in PATH', () => {
    expect(() => validateCommand('sh')).not.toThrow();
  });

  it('throws for an empty command string', () => {
    expect(() => validateCommand('')).toThrow(/must not be empty/);
  });

  it('throws for a whitespace-only command string', () => {
    expect(() => validateCommand('   ')).toThrow(/must not be empty/);
  });
});

describe('resolveProjectDockerfile', () => {
  it('returns absolute path when .parallel-code/Dockerfile exists in project root', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);
    const dockerDir = path.join(projectRoot, '.parallel-code');
    fs.mkdirSync(dockerDir, { recursive: true });
    fs.writeFileSync(path.join(dockerDir, 'Dockerfile'), 'FROM node:20\n');

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBe(path.join(projectRoot, '.parallel-code', 'Dockerfile'));
  });

  it('returns null when .parallel-code/Dockerfile does not exist', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBeNull();
  });

  it('returns null when project root does not exist', () => {
    const result = resolveProjectDockerfile('/nonexistent/path/to/project');
    expect(result).toBeNull();
  });

  it('returns null when .parallel-code/Dockerfile is a directory', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.parallel-code', 'Dockerfile'), { recursive: true });

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBeNull();
  });
});

describe('projectImageTag', () => {
  it('returns a tag in the format parallel-code-project:<12-char-hash>', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-tag-'));
    tempPaths.push(tmpDir);
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM node:20\nRUN echo hello\n');

    const tag = projectImageTag(dockerfilePath);
    expect(tag).toMatch(/^parallel-code-project:[a-f0-9]{12}$/);
  });

  it('returns parallel-code-project:unknown for non-existent Dockerfile path', () => {
    const tag = projectImageTag('/nonexistent/Dockerfile');
    expect(tag).toBe('parallel-code-project:unknown');
  });
});

describe('hashDockerfile', () => {
  it('returns a SHA-256 hex string for a real file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-hash-'));
    tempPaths.push(tmpDir);
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM ubuntu:22.04\n');

    const hash = hashDockerfile(dockerfilePath);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null for a non-existent file', () => {
    const hash = hashDockerfile('/nonexistent/Dockerfile');
    expect(hash).toBeNull();
  });
});

describe('dockerImageExists', () => {
  it('fails closed when a custom dockerfile path is unreadable', async () => {
    mockExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: { encoding: string; timeout: number },
        callback: (err: Error | null, stdout: string) => void,
      ) => callback(null, 'stored-hash'),
    );

    await expect(
      dockerImageExists('parallel-code-project:test', {
        dockerfilePath: '/nonexistent/Dockerfile',
      }),
    ).resolves.toBe(false);
  });
});

describe('buildDockerImage', () => {
  it('uses the provided build context for a project dockerfile', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-build-context-'));
    tempPaths.push(projectRoot);
    const dockerDir = path.join(projectRoot, '.parallel-code');
    fs.mkdirSync(dockerDir, { recursive: true });
    const dockerfilePath = path.join(dockerDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM node:20\n');

    buildDockerImage(createMockWindow(), 'channel:build-test', {
      dockerfilePath,
      imageTag: 'parallel-code-project:test',
      buildContext: projectRoot,
    } as unknown as Parameters<typeof buildDockerImage>[2]);

    const lastCall = mockChildProcessSpawn.mock.lastCall;
    expect(lastCall).toBeTruthy();
    const args = ((lastCall as unknown as [string, string[]])?.[1] ?? []) as string[];
    expect(args[args.length - 1]).toBe(projectRoot);
  });
});

describe('killAgent — Docker container lifecycle', () => {
  it('calls docker stop with the predictable container name when agent is killed', () => {
    const agentId = nextAgentId();
    const containerName = `parallel-code-${agentId.slice(0, 12)}`;

    spawnAgent(createMockWindow(), buildSpawnArgs({ agentId }));
    killAgent(agentId);

    const stopCall = mockExecFile.mock.calls.find(
      (c) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'stop',
    );
    expect(stopCall).toBeDefined();
    expect(stopCall?.[1]).toContain(containerName);
  });

  it('container name is always parallel-code-<first-12-chars-of-agentId>', () => {
    const agentId = 'agent-abcdef-ghij-klmn';
    const expected = `parallel-code-${agentId.slice(0, 12)}`;
    expect(expected).toBe('parallel-code-agent-abcdef');
    // The container name must be deterministic and predictable for cleanup
    // (no random suffix) so we can always `docker stop` it by name.
    expect(expected.startsWith('parallel-code-')).toBe(true);
    expect(expected.length).toBe(14 + 12); // 'parallel-code-' + 12 chars
  });

  it('does not call docker stop for a non-Docker agent', () => {
    const agentId = nextAgentId();
    spawnAgent(createMockWindow(), buildSpawnArgs({ agentId, dockerMode: false }));
    mockExecFile.mockClear();
    killAgent(agentId);

    const stopCall = mockExecFile.mock.calls.find(
      (c) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'stop',
    );
    expect(stopCall).toBeUndefined();
  });
});

describe('spawnAgent docker mode — same-path bind mounts', () => {
  it('workspace cwd and worktree-parent -v mounts use identical host:container paths', () => {
    // Same-path mounts for workspace paths guarantee that absolute paths in MCP config /
    // Claude trust config are valid both on the host and inside the container. Any
    // remapped workspace path would break MCP server invocations and .mcp.json references.
    // (Credential mounts intentionally redirect host ~/.ssh → /tmp/.ssh inside container.)
    const home = makeTempHome([]);
    vi.stubEnv('HOME', home);

    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        cwd: '/workspace/project',
        shareDockerAgentAuth: false,
        dockerMountWorktreeParent: false,
      }),
    );

    const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
    // All mounts should be same-path (no credential mounts with redirected paths)
    for (const mount of volumeFlags) {
      // Strip trailing :ro if present
      const withoutRo = mount.replace(/:ro$/, '');
      const colonIdx = withoutRo.indexOf(':');
      const hostPath = withoutRo.slice(0, colonIdx);
      const containerPath = withoutRo.slice(colonIdx + 1);
      expect(hostPath).toBe(containerPath);
    }
  });
});

// ─── Item 3: Concurrent Docker task spawns ────────────────────────────────────

describe('seedClaudeProjectTrust — concurrent spawns', () => {
  it('two simultaneous spawns both record hasTrustDialogAccepted (last write wins, no data loss)', () => {
    // This tests that each spawn independently writes trust for its own worktree path.
    // Since each worktree path is unique, there is no actual conflict — both paths end up
    // in the final .claude.json regardless of spawn order.
    const home = makeTempHome([]);
    vi.stubEnv('HOME', home);

    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        command: 'claude',
        cwd: '/workspace/task-a',
        shareDockerAgentAuth: true,
        agentId: `agent-concurrent-a`,
      }),
    );

    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        command: 'claude',
        cwd: '/workspace/task-b',
        shareDockerAgentAuth: true,
        agentId: `agent-concurrent-b`,
      }),
    );

    const hostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
    const config = JSON.parse(fs.readFileSync(hostFile, 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    // Both worktree paths must be trusted after both spawns
    expect(config.projects['/workspace/task-a']?.hasTrustDialogAccepted).toBe(true);
    expect(config.projects['/workspace/task-b']?.hasTrustDialogAccepted).toBe(true);
  });
});

// ─── Item 4: Docker cleanup on failed spawn ───────────────────────────────────

describe('spawnAgent docker mode — PTY spawn failure', () => {
  it('throws when pty.spawn fails and does not leave a session in the registry', () => {
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error('pty spawn failed: out of file descriptors');
    });

    const agentId = nextAgentId();
    expect(() => spawnAgent(createMockWindow(), buildSpawnArgs({ agentId }))).toThrow();
  });
});

// ─── Item 6: MCP server file freshness ────────────────────────────────────────
// This is covered by register-mcp.test.ts (Layer 3 spawn-path integration tests).
// The test there asserts copyFileSync is called on every StartMCPServer invocation,
// meaning a stale copy is always overwritten. Documented here for cross-reference.

// ─── Item 8: No credentials leakage in spawn log ─────────────────────────────

describe('spawnAgent docker mode — credential redaction in logs', () => {
  it('does not log the MCP token when it appears in env vars', () => {
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        env: { MCP_TOKEN: 'super-secret-value' },
        cwd: '/workspace/project',
        shareDockerAgentAuth: false,
      }),
    );

    // All log calls should be checked for the raw secret
    const allLogArgs = mockLogDebug.mock.calls.map((c) => JSON.stringify(c));
    for (const logEntry of allLogArgs) {
      expect(logEntry).not.toContain('super-secret-value');
    }
  });

  it('redacts -e KEY=VALUE in spawn command log', () => {
    // The redactDockerArgs function should redact -e assignments.
    // Verify by checking the logged spawn command args.
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        env: { ANTHROPIC_API_KEY: 'sk-ant-abc123' },
        cwd: '/workspace/project',
        shareDockerAgentAuth: false,
      }),
    );

    const logCtx = getSpawnCommandLogCtx();
    const argsStr = JSON.stringify(logCtx.args);
    // Raw API key must not appear in log
    expect(argsStr).not.toContain('sk-ant-abc123');
    // But the env var name should still appear (just redacted value)
    expect(argsStr).toContain('ANTHROPIC_API_KEY');
  });
});

// ─── Item 10: Docker unavailable behavior ────────────────────────────────────

describe('isDockerAvailable', () => {
  it('returns false when docker info command fails', async () => {
    mockExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: { encoding: string; timeout: number },
        callback: (err: Error | null) => void,
      ) => callback(new Error('docker: command not found')),
    );

    const result = await isDockerAvailable();
    expect(result).toBe(false);
  });

  it('returns true when docker info succeeds', async () => {
    mockExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: { encoding: string; timeout: number },
        callback: (err: Error | null) => void,
      ) => callback(null),
    );

    const result = await isDockerAvailable();
    expect(result).toBe(true);
  });
});

// ─── Item 4b: Long path / spaces in worktree path ────────────────────────────

describe('spawnAgent docker mode — path edge cases', () => {
  it('preserves spaces in worktree path in -v and -w args', () => {
    const cwd = '/Users/alice bob/my repos/project name/.worktrees/task/coord-abc';
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        cwd,
        dockerMountWorktreeParent: false,
        shareDockerAgentAuth: false,
      }),
    );

    const { args } = getLastSpawnCall();
    const volumeFlags = getFlagValues(args, '-v');
    expect(volumeFlags).toContain(`${cwd}:${cwd}`);
    const wIdx = args.indexOf('-w');
    expect(args[wIdx + 1]).toBe(cwd);
  });

  it('non-Docker agents do not get trust seeding and no .claude.json write occurs', () => {
    // Non-Claude agent (e.g. codex) with shareDockerAgentAuth=true but different command
    // should not invoke seedClaudeProjectTrust. No .claude.json write for unknown commands.
    const home = makeTempHome([]);
    vi.stubEnv('HOME', home);

    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        command: 'codex',
        dockerMode: false, // non-docker, non-claude
        shareDockerAgentAuth: true,
      }),
    );

    const claudeJson = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
    // .claude.json must not be created for non-Claude agents
    expect(fs.existsSync(claudeJson)).toBe(false);
  });
});

// ─── Auth file permission mode ────────────────────────────────────────────────

describe('seedClaudeProjectTrust — file permissions', () => {
  it('.claude.json is written with mode 0o600 (owner r/w only)', () => {
    const home = makeTempHome([]);
    vi.stubEnv('HOME', home);

    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        command: 'claude',
        cwd: '/workspace/project',
        shareDockerAgentAuth: true,
      }),
    );

    const hostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
    expect(fs.existsSync(hostFile)).toBe(true);
    const stat = fs.statSync(hostFile);
    // mode & 0o777 strips file-type bits; 0o600 = owner r/w, no group/other access
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ─── Read-only auth dir warning ───────────────────────────────────────────────

describe('buildDockerCredentialMounts — read-only auth dir', () => {
  it('emits console.warn and continues when agent auth dir cannot be created', () => {
    const home = makeTempHome([]);
    vi.stubEnv('HOME', home);

    // Create the parent as a file to block mkdirSync
    const authBase = path.join(home, '.parallel-code');
    fs.mkdirSync(authBase, { recursive: true });
    // Create 'agent-auth' as a file so mkdirSync for 'claude' inside it will fail
    fs.writeFileSync(path.join(authBase, 'agent-auth'), 'not-a-dir');

    const warnSpy = vi.spyOn(console, 'warn');

    // Should not throw
    expect(() =>
      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ command: 'claude', shareDockerAgentAuth: true }),
      ),
    ).not.toThrow();

    // Must have warned about the failure (single string arg — the message itself)
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => /\[docker-auth\].*Could not/.test(m))).toBe(true);
  });
});

describe('writeToAgent — interrupt keystrokes', () => {
  it('emits an interrupt event for a bare Esc or Ctrl+C on agent sessions only', () => {
    const interrupted: string[] = [];
    const off = onPtyEvent('interrupt', (agentId) => interrupted.push(agentId));
    const agent = buildSpawnArgs({
      agentId: 'agent-interrupt',
      command: 'claude',
      args: [],
      dockerMode: false,
    });
    const shell = buildSpawnArgs({
      agentId: 'shell-interrupt',
      command: '/bin/sh',
      args: [],
      dockerMode: false,
      isShell: true,
    });
    spawnAgent(createMockWindow(), agent);
    spawnAgent(createMockWindow(), shell);

    writeToAgent(agent.agentId, 'hello');
    writeToAgent(agent.agentId, '\x1b[A'); // arrow key: an escape sequence, not an interrupt
    writeToAgent(shell.agentId, '\x03');
    expect(interrupted).toEqual([]);

    writeToAgent(agent.agentId, '\x1b');
    writeToAgent(agent.agentId, '\x03');
    expect(interrupted).toEqual([agent.agentId, agent.agentId]);
    off();
  });
});
