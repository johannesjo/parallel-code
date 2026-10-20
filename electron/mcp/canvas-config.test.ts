import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  canConfigureCanvasMcp,
  prepareCanvasMcpArgs,
  removeAllCanvasConfigs,
  removeCanvasConfig,
} from './canvas-config.js';

let directory: string;
let id: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-config-test-'));
  id = path.basename(directory);
  fs.writeFileSync(path.join(directory, 'server.cjs'), '// server');
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), `parallel-code-canvas-${id}.json`), { force: true });
});
const options = () => ({
  command: 'claude',
  taskId: 'task-1',
  agentId: id,
  cwd: directory,
  serverPath: path.join(directory, 'server.cjs'),
  port: 7777,
  token: 'test-token',
});

it('preserves explicit MCP configurations and leaves unsupported CLI commands alone', () => {
  for (const command of ['claude', '/usr/bin/codex', 'copilot'])
    expect(canConfigureCanvasMcp(command, ['--resume', 'session'])).toBe(true);
  for (const args of [
    ['--mcp-config', 'my-config.json'],
    ['--mcp-config=my-config.json'],
    ['--additional-mcp-config', '@my-config.json'],
    ['--strict-mcp-config'],
    ['-c', 'mcp_servers.custom.command="node"'],
    ['--config=mcp_servers.custom.command="node"'],
  ])
    expect(canConfigureCanvasMcp('codex', args)).toBe(false);
  expect(canConfigureCanvasMcp('bash', [])).toBe(false);
  expect(canConfigureCanvasMcp('custom-agent', [])).toBe(false);
});

it('rejects a missing MCP bundle before creating a session configuration', () => {
  expect(() =>
    prepareCanvasMcpArgs({ ...options(), serverPath: path.join(directory, 'missing.cjs') }),
  ).toThrow();
  expect(fs.existsSync(path.join(os.tmpdir(), `parallel-code-canvas-${id}.json`))).toBe(false);
});

it('configures a task-scoped MCP without changing project config and restricts credential permissions', () => {
  fs.writeFileSync(path.join(directory, '.mcp.json'), '{"existing":true}');
  const args = prepareCanvasMcpArgs(options());
  const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  expect(args[0]).toBe('--mcp-config');
  expect(config.mcpServers['parallel-code'].args).toEqual([
    path.join(directory, 'server.cjs'),
    '--url',
    'http://127.0.0.1:7777',
    '--task-id',
    'task-1',
    '--canvas-only',
  ]);
  expect(fs.statSync(args[1]).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(path.join(directory, '.mcp.json'), 'utf8')).toBe('{"existing":true}');
  expect(prepareCanvasMcpArgs({ ...options(), command: 'codex' })[0]).toBe('--config');
  expect(prepareCanvasMcpArgs({ ...options(), command: 'copilot' })[0]).toBe(
    '--additional-mcp-config',
  );
});

it('puts Docker configs and the server inside the task mount', () => {
  const args = prepareCanvasMcpArgs({ ...options(), dockerMode: true });
  expect(args[1]).toBe(path.join(directory, '.parallel-code', `parallel-code-canvas-${id}.json`));
  const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  expect(config.mcpServers['parallel-code'].args[0]).toBe(
    path.join(directory, '.parallel-code', 'canvas-mcp-server.cjs'),
  );
  expect(fs.readFileSync(config.mcpServers['parallel-code'].args[0], 'utf8')).toBe('// server');
});

it('removes the copied Docker bundle with the last config that uses it, never through a link', () => {
  const bundle = path.join(directory, '.parallel-code', 'canvas-mcp-server.cjs');
  const first = prepareCanvasMcpArgs({ ...options(), dockerMode: true })[1];
  const second = prepareCanvasMcpArgs({ ...options(), agentId: `${id}-b`, dockerMode: true })[1];
  removeCanvasConfig(id);
  expect(fs.existsSync(first)).toBe(false);
  expect(fs.existsSync(bundle)).toBe(true);
  removeCanvasConfig(`${id}-b`);
  expect(fs.existsSync(second)).toBe(false);
  expect(fs.existsSync(bundle)).toBe(false);
  prepareCanvasMcpArgs({ ...options(), dockerMode: true });
  fs.unlinkSync(bundle);
  fs.symlinkSync(path.join(directory, 'server.cjs'), bundle);
  removeAllCanvasConfigs();
  expect(fs.lstatSync(bundle).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(path.join(directory, 'server.cjs'), 'utf8')).toBe('// server');
});

it('rejects invalid identities and symlinked Docker config directories', () => {
  expect(() => prepareCanvasMcpArgs({ ...options(), agentId: '../escape' })).toThrow('Invalid');
  const destination = path.join(directory, 'elsewhere');
  fs.mkdirSync(destination);
  fs.symlinkSync(destination, path.join(directory, '.parallel-code'));
  expect(() => prepareCanvasMcpArgs({ ...options(), dockerMode: true })).toThrow('symbolic link');
  expect(fs.readdirSync(destination)).toEqual([]);
});

it('keeps the Codex token out of argv and points the server at the credential file', () => {
  const args = prepareCanvasMcpArgs({ ...options(), command: 'codex' });
  const configPath = path.join(os.tmpdir(), `parallel-code-canvas-${id}.json`);
  expect(args[0]).toBe('--config');
  expect(args[1]).not.toContain('test-token');
  expect(args[1]).toContain(`"--token-file", ${JSON.stringify(configPath)}`);
  expect(args[1]).toContain('env = {}');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(config.mcpServers['parallel-code'].env).toEqual({ PARALLEL_CODE_MCP_TOKEN: 'test-token' });
});

it('removes tracked credential files on exit and quit, tolerating files already gone', () => {
  const configPath = prepareCanvasMcpArgs(options())[1];
  expect(fs.existsSync(configPath)).toBe(true);
  removeCanvasConfig(id);
  expect(fs.existsSync(configPath)).toBe(false);
  expect(() => removeCanvasConfig(id)).not.toThrow();
  prepareCanvasMcpArgs(options());
  fs.unlinkSync(configPath);
  expect(() => removeAllCanvasConfigs()).not.toThrow();
  prepareCanvasMcpArgs(options());
  removeAllCanvasConfigs();
  expect(fs.existsSync(configPath)).toBe(false);
});

it('launches ordinary session tools without the legacy canvas-only restriction', () => {
  const args = prepareCanvasMcpArgs({
    ...options(),
    sessionCapabilities: { profile: 'ordinary', canCreate: true, peers: true },
  });
  const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  expect(config.mcpServers['parallel-code'].args).toEqual([
    path.join(directory, 'server.cjs'),
    '--url',
    'http://127.0.0.1:7777',
    '--task-id',
    'task-1',
    '--session-profile',
    'ordinary',
    '--allow-create',
    '--peer-tools',
  ]);
  expect(config.mcpServers['parallel-code'].env.PARALLEL_CODE_MCP_TOKEN).toBe('test-token');
});
