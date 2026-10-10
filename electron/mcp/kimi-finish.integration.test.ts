import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Coordinator } from './coordinator.js';
import { DelegationService } from './delegation.js';
import { getSubTaskMcpConfigPath } from './config.js';
import { mergeTask } from '../ipc/git.js';

const directories: string[] = [];
const credentials: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function fixture(command = 'kimi') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-finish-')));
  directories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  appendFileSync(join(root, '.git/info/exclude'), '/.worktrees/\n');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, 'add', 'base.txt');
  git(root, 'commit', '-m', 'initial');
  const child = join(root, '.worktrees/child');
  git(root, 'worktree', 'add', '-b', 'child', child);
  const id = randomUUID();
  const config = getSubTaskMcpConfigPath(null, '', id);
  credentials.push(config);
  const discovery = join(child, '.kimi-code/mcp.json');
  const other = { command: 'user-owned-server' };
  mkdirSync(dirname(discovery), { recursive: true });
  writeFileSync(discovery, JSON.stringify({ mcpServers: { other } }));
  const coordinator = new Coordinator();
  coordinator.setNotify(() => undefined);
  coordinator.registerCoordinator('parent', 'project', {
    projectRoot: root,
    branchName: 'main',
    worktreePath: root,
    automaticNotifications: false,
  });
  coordinator.setMCPServerInfo(
    'parent',
    'http://localhost:3001',
    'synthetic-parent-token',
    'synthetic-child-token',
    '/server.js',
  );
  coordinator.hydrateTask({
    id,
    name: 'child',
    projectId: 'project',
    projectRoot: root,
    branchName: 'child',
    baseBranch: 'main',
    worktreePath: child,
    agentId: `agent-${id}`,
    coordinatorTaskId: 'parent',
    integrationPolicy: 'review',
    agentCommand: command,
    mcpConfigPath: config,
  });
  const service = new DelegationService({
    coordinator: async () => coordinator,
    currentCoordinator: () => coordinator,
    prepareParent: async () => undefined,
    sessions: () => [],
    changed: () => undefined,
    persist: () => undefined,
  });
  await service.register({
    taskId: 'parent',
    name: 'parent',
    projectId: 'project',
    projectRoot: root,
    worktreePath: root,
    branchName: 'main',
    gitIsolation: 'direct',
    agentCommand: 'codex',
    agentArgs: [],
  });
  await service.register({
    taskId: id,
    name: 'child',
    projectId: 'project',
    projectRoot: root,
    worktreePath: child,
    branchName: 'child',
    gitIsolation: 'worktree',
    parentTaskId: 'parent',
    integrationPolicy: 'review',
    agentCommand: command,
    agentArgs: [],
  });
  // These are the production operations used by the desktop Finish IPC handler.
  const finish = async () => {
    await service.assertDirectMergeAllowed(root, 'child');
    const result = await mergeTask(root, 'child', false, null, false, 'main', child);
    await service.recordDirectMerge(root, 'child');
    return result;
  };
  const commit = (path: string, contents: string) => {
    const file = join(child, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    git(child, 'add', '-f', path);
    git(child, 'commit', '-m', 'child change');
  };
  return { root, child, id, config, discovery, other, coordinator, service, finish, commit };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of credentials.splice(0)) rmSync(path, { force: true });
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Kimi children merged through Finish', () => {
  it.each([
    '.kimi-code/mcp.json',
    '.kimi-code/.parallel-code-atomic-child.tmp',
    '.parallel-code-atomic-root.tmp',
  ])('refuses force-added token history in %s without advancing the target', async (path) => {
    const f = await fixture();
    const target = git(f.root, 'rev-parse', 'HEAD');
    f.commit(path, readFileSync(f.discovery, 'utf8'));
    await expect(f.finish()).rejects.toThrow('Managed Kimi MCP token was found');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(target);
    expect(f.coordinator.getTask(f.id)?.landingState).not.toBe('reviewed');
    // Failure preserves the private credentials and unrelated user-owned server.
    expect(JSON.parse(readFileSync(f.discovery, 'utf8')).mcpServers).toMatchObject({
      other: f.other,
    });
    expect(JSON.parse(readFileSync(f.config, 'utf8')).mcpServers).toMatchObject({
      'parallel-code': { env: { PARALLEL_CODE_MCP_TOKEN: 'synthetic-child-token' } },
    });
  });

  it('still refuses a token-bearing commit after the discovery file was deleted', async () => {
    const f = await fixture();
    f.commit('.kimi-code/mcp.json', readFileSync(f.discovery, 'utf8'));
    unlinkSync(f.discovery);
    git(f.child, 'add', '-u');
    git(f.child, 'commit', '-m', 'remove discovery file');
    const target = git(f.root, 'rev-parse', 'HEAD');
    await expect(f.finish()).rejects.toThrow('Managed Kimi MCP token was found');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(target);
  });

  it('merges safe work, preserves other servers, and records user review', async () => {
    const f = await fixture('/usr/local/bin/kimi');
    f.commit('result.txt', 'safe result\n');
    await f.finish();
    expect(readFileSync(join(f.root, 'result.txt'), 'utf8')).toBe('safe result\n');
    expect(JSON.parse(readFileSync(f.discovery, 'utf8'))).toEqual({
      mcpServers: { other: f.other },
    });
    expect(f.coordinator.getTask(f.id)?.autoDiscoveredMcpConfig).toBeUndefined();
    expect(f.coordinator.getTask(f.id)?.landingState).toBe('reviewed');
  });

  it('fails closed on edited credentials and permits retry after repairing only the entry', async () => {
    const f = await fixture();
    const original = readFileSync(f.discovery, 'utf8');
    writeFileSync(
      f.discovery,
      JSON.stringify({ mcpServers: { other: f.other, 'parallel-code': { command: 'edited' } } }),
    );
    const target = git(f.root, 'rev-parse', 'HEAD');
    await expect(f.finish()).rejects.toThrow('Unable to restore managed Kimi MCP config');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(target);
    expect(readFileSync(f.discovery, 'utf8')).toContain('edited');
    writeFileSync(f.discovery, original);
    f.commit('result.txt', 'retry result\n');
    await f.finish();
    expect(f.coordinator.getTask(f.id)?.landingState).toBe('reviewed');
  });

  it('retains the history gate across a successful preflight followed by a merge failure', async () => {
    const f = await fixture();
    const original = readFileSync(f.discovery, 'utf8');
    await f.service.assertDirectMergeAllowed(f.root, 'child');
    // Finish can fail after preflight (for example, a merge conflict). A retry
    // must not lose the gate merely because the first restore removed its entry.
    f.commit('.kimi-code/.parallel-code-atomic-retry.tmp', original);
    const target = git(f.root, 'rev-parse', 'HEAD');
    await expect(f.finish()).rejects.toThrow('Managed Kimi MCP token was found');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(target);
  });

  it('leaves ordinary non-Kimi children unchanged', async () => {
    const f = await fixture('claude');
    expect(existsSync(f.discovery)).toBe(true);
    f.commit('result.txt', 'ordinary result\n');
    await f.finish();
    expect(f.coordinator.getTask(f.id)?.landingState).toBe('reviewed');
    expect(JSON.parse(readFileSync(f.discovery, 'utf8'))).toEqual({
      mcpServers: { other: f.other },
    });
  });
});
