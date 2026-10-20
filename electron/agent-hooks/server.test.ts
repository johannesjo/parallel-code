import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAgentHookServer, type AgentHookServer } from './server.js';
import { registerAgentLaunch, retireAgentLaunch } from './observations.js';
import type { AgentHookEventPayload } from './status.js';

function tokenFrom(dir: string): string {
  const match = fs.readFileSync(path.join(dir, 'endpoint.env'), 'utf8').match(/TOKEN=(.+)/);
  if (!match) throw new Error('endpoint.env has no token');
  return match[1];
}

describe('startAgentHookServer', () => {
  let dir: string;
  let server: AgentHookServer;
  let events: AgentHookEventPayload[];
  let usage: unknown[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-'));
    events = [];
    usage = [];
    registerAgentLaunch('agent-1', 'task-1', 'launch-1');
    registerAgentLaunch('agent-sh', 'task-sh', 'launch-sh');
    server = await startAgentHookServer({
      dir,
      onEvent: (e) => events.push(e),
      onUsage: (p) => usage.push(p),
      now: () => 1234,
    });
  });

  afterEach(async () => {
    await server.close();
    retireAgentLaunch('agent-1', 'launch-1');
    retireAgentLaunch('agent-sh', 'launch-sh');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function post(
    body: string,
    headers: Record<string, string> = {},
    url = '/hook/claude',
  ): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    return res.status;
  }

  it('writes the endpoint file, script, and settings pointing at the script', () => {
    const endpoint = fs.readFileSync(path.join(dir, 'endpoint.env'), 'utf8');
    expect(endpoint).toContain(`PARALLEL_CODE_HOOK_PORT=${server.port}\n`);
    expect(fs.statSync(server.hookScriptPath).mode & 0o111).not.toBe(0);
    const settingsPath = server.claudeSettingsPath(dir, { CLAUDE_CONFIG_DIR: dir });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(server.hookScriptPath);
    expect(settings.statusLine.command).toBe(`/bin/sh '${server.statusLineScriptPath}'`);
  });

  it("wraps the user's own status line, and leaves an unreadable one alone", () => {
    const configDir = path.join(dir, 'config');
    const cwd = path.join(dir, 'work');
    fs.mkdirSync(configDir);
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: configDir };
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo user', padding: 2 } }),
    );
    const read = (): { statusLine?: { command: string; padding?: number } } =>
      JSON.parse(fs.readFileSync(server.claudeSettingsPath(cwd, env), 'utf8'));
    expect(read().statusLine).toEqual({
      type: 'command',
      command: `/bin/sh '${server.statusLineScriptPath}' 'echo user'`,
      padding: 2,
    });
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo local' } }),
    );
    expect(read().statusLine?.command).toContain("'echo local'");
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{ broken');
    expect(read().statusLine).toBeUndefined();
    expect(read()).toHaveProperty('hooks.Stop');
  });

  it('hands authenticated status line payloads to onUsage without an agent identity', async () => {
    const body = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5 } } });
    expect(await post(body, {}, '/usage/claude')).toBe(403);
    expect(
      await post(body, { 'x-parallel-code-hook-token': tokenFrom(dir) }, '/usage/claude'),
    ).toBe(204);
    await vi.waitFor(() => expect(usage).toHaveLength(1));
    expect(usage[0]).toEqual(JSON.parse(body));
    expect(events).toHaveLength(0);
  });

  it('forwards an authenticated event stamped with agent, task, and time', async () => {
    const status = await post(
      JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'All done' }),
      {
        'x-parallel-code-hook-token': tokenFrom(dir),
        'x-parallel-code-agent-id': 'agent-1',
        'x-parallel-code-task-id': 'task-1',
        'x-parallel-code-launch-id': 'launch-1',
      },
    );
    expect(status).toBe(204);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      state: 'done',
      event: 'Stop',
      lastAssistantMessage: 'All done',
      agentId: 'agent-1',
      taskId: 'task-1',
      launchId: 'launch-1',
      at: 1234,
    });
  });

  it('drops missing, foreign-task, retired, and replaced launch identities', async () => {
    const auth = {
      'x-parallel-code-hook-token': tokenFrom(dir),
      'x-parallel-code-agent-id': 'agent-1',
      'x-parallel-code-task-id': 'task-1',
    };
    const body = JSON.stringify({ hook_event_name: 'Stop' });
    expect(await post(body, auth)).toBe(204);
    expect(await post(body, { ...auth, 'x-parallel-code-launch-id': 'wrong' })).toBe(204);
    expect(
      await post(body, {
        ...auth,
        'x-parallel-code-launch-id': 'launch-1',
        'x-parallel-code-task-id': 'wrong',
      }),
    ).toBe(204);
    retireAgentLaunch('agent-1', 'launch-1');
    expect(await post(body, { ...auth, 'x-parallel-code-launch-id': 'launch-1' })).toBe(204);
    registerAgentLaunch('agent-1', 'task-1', 'launch-2');
    try {
      expect(await post(body, { ...auth, 'x-parallel-code-launch-id': 'launch-1' })).toBe(204);
      expect(events).toHaveLength(0);
      await post(body, { ...auth, 'x-parallel-code-launch-id': 'launch-2' });
      await vi.waitFor(() => expect(events).toHaveLength(1));
    } finally {
      retireAgentLaunch('agent-1', 'launch-2');
    }
  });

  it('rejects a missing or wrong token without leaking anything', async () => {
    expect(await post('{}', { 'x-parallel-code-agent-id': 'a' })).toBe(403);
    expect(
      await post('{}', { 'x-parallel-code-hook-token': 'nope', 'x-parallel-code-agent-id': 'a' }),
    ).toBe(403);
    expect(events).toHaveLength(0);
  });

  it('still answers 204 for garbage or unmapped payloads and drops them', async () => {
    const auth = { 'x-parallel-code-hook-token': tokenFrom(dir), 'x-parallel-code-agent-id': 'a' };
    expect(await post('not json', auth)).toBe(204);
    expect(await post(JSON.stringify({ hook_event_name: 'PreCompact' }), auth)).toBe(204);
    expect(events).toHaveLength(0);
  });

  it('ignores events with no agent id, which cannot be attributed', async () => {
    expect(
      await post(JSON.stringify({ hook_event_name: 'Stop' }), {
        'x-parallel-code-hook-token': tokenFrom(dir),
      }),
    ).toBe(204);
    expect(events).toHaveLength(0);
  });

  it('404s anything that is not the hook route', async () => {
    expect(await post('{}', { 'x-parallel-code-hook-token': tokenFrom(dir) }, '/other')).toBe(404);
  });

  it('tightens permissions left loose by a previous launch', async () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-loose-'));
    fs.chmodSync(loose, 0o755);
    fs.writeFileSync(path.join(loose, 'endpoint.env'), 'stale', { mode: 0o644 });
    const second = await startAgentHookServer({ dir: loose, onEvent: () => undefined });
    try {
      expect(fs.statSync(loose).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(loose, 'endpoint.env')).mode & 0o777).toBe(0o600);
    } finally {
      await second.close();
      fs.rmSync(loose, { recursive: true, force: true });
    }
  });

  it('rejects instead of crashing when the hook directory cannot be written', async () => {
    const blocked = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocked, '');
    await expect(
      startAgentHookServer({ dir: path.join(blocked, 'child'), onEvent: () => undefined }),
    ).rejects.toThrow();
  });

  it('hands the PTY layer the env the script needs', () => {
    expect(server.buildPtyEnv('agent-9', 'task-9', 'launch-9')).toEqual({
      PARALLEL_CODE_HOOK_ENDPOINT: path.join(dir, 'endpoint.env'),
      PARALLEL_CODE_AGENT_ID: 'agent-9',
      PARALLEL_CODE_TASK_ID: 'task-9',
      PARALLEL_CODE_LAUNCH_ID: 'launch-9',
    });
  });

  it('round-trips through the generated shell script itself', async () => {
    const { execFile } = await import('child_process');
    const env = {
      ...process.env,
      ...server.buildPtyEnv('agent-sh', 'task-sh', 'launch-sh'),
    };
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('/bin/sh', [server.hookScriptPath], { env }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
      child.stdin?.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
    });
    expect(stdout).toBe('{}\n');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ state: 'working', agentId: 'agent-sh', taskId: 'task-sh' });
  });

  async function runStatusLine(input: unknown, userCommand?: string): Promise<string> {
    const { execFile } = await import('child_process');
    const env = { ...process.env, ...server.buildPtyEnv('agent-sh', 'task-sh', 'launch-sh') };
    const args = [server.statusLineScriptPath, ...(userCommand ? [userCommand] : [])];
    return new Promise<string>((resolve, reject) => {
      const child = execFile('/bin/sh', args, { env }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
      child.stdin?.end(JSON.stringify(input));
    });
  }

  it("reports rate limits through the status line script, then prints the user's line", async () => {
    const input = { model: { id: 'm' }, rate_limits: { five_hour: { used_percentage: 7 } } };
    const out = await runStatusLine(
      input,
      // The user's command sees the same payload, but not the app's token.
      `wc -c | tr -d ' '; printf '%s' "\${PARALLEL_CODE_HOOK_TOKEN-none}"`,
    );
    expect(out).toBe(`${JSON.stringify(input).length}\nnone`);
    await vi.waitFor(() => expect(usage).toHaveLength(1));
    expect(usage[0]).toEqual(input);
  });

  it('prints nothing and posts nothing without rate limits or a user status line', async () => {
    expect(await runStatusLine({ model: { id: 'm' } })).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(usage).toHaveLength(0);
  });
});
