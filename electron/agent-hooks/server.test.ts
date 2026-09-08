import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAgentHookServer, type AgentHookServer } from './server.js';
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

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-'));
    events = [];
    server = await startAgentHookServer({ dir, onEvent: (e) => events.push(e), now: () => 1234 });
  });

  afterEach(async () => {
    await server.close();
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
    const settings = JSON.parse(fs.readFileSync(server.claudeSettingsPath, 'utf8'));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(server.hookScriptPath);
  });

  it('forwards an authenticated event stamped with agent, task, and time', async () => {
    const status = await post(
      JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'All done' }),
      {
        'x-parallel-code-hook-token': tokenFrom(dir),
        'x-parallel-code-agent-id': 'agent-1',
        'x-parallel-code-task-id': 'task-1',
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
      at: 1234,
    });
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
    expect(server.buildPtyEnv('agent-9', 'task-9')).toEqual({
      PARALLEL_CODE_HOOK_ENDPOINT: path.join(dir, 'endpoint.env'),
      PARALLEL_CODE_AGENT_ID: 'agent-9',
      PARALLEL_CODE_TASK_ID: 'task-9',
    });
  });

  it('round-trips through the generated shell script itself', async () => {
    const { execFile } = await import('child_process');
    const env = {
      ...process.env,
      ...server.buildPtyEnv('agent-sh', 'task-sh'),
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
});
