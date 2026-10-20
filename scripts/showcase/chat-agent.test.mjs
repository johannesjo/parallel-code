/* global process, setTimeout */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(import.meta.dirname, 'chat-agent.mjs');
const SESSION = '0b5f6f7e-2d4a-4f47-9a51-5f0c1d7e0aff';
const EDIT = { tool: 'Edit', input: { file_path: 'src/dates.ts' } };

const cleanups = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** Starts the stand-in with a script and collects what it writes. */
const start = (script) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-agent-'));
  fs.writeFileSync(path.join(dir, `${SESSION}.json`), JSON.stringify(script));
  const child = spawn(process.execPath, [SCRIPT, dir, '--session-id', SESSION]);
  cleanups.push(() => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const messages = [];
  createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (predicate) =>
    expect.poll(() => messages.find(predicate), { timeout: 5000 }).toBeDefined();
  send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
  return { messages, send, waitFor };
};

const isPermission = (message) => message.request?.subtype === 'can_use_tool';
const isResult = (message) => message.type === 'result';
const toolResult = (messages) =>
  messages.find((message) => message.message?.content?.[0]?.type === 'tool_result')?.message
    .content[0];

const answer = (agent, behavior) => {
  const request = agent.messages.find(isPermission);
  agent.send({
    type: 'control_response',
    response: { subtype: 'success', request_id: request.request_id, response: { behavior } },
  });
};

describe('chat-agent', () => {
  it('applies an allowed edit, says so, and ends the turn', async () => {
    const agent = start({ start: [{ approve: EDIT, after: 'Applied.' }] });
    await agent.waitFor(isPermission);
    answer(agent, 'allow');
    await agent.waitFor(isResult);
    expect(toolResult(agent.messages).is_error).toBeFalsy();
    const texts = agent.messages.flatMap((m) => m.message?.content ?? []).map((c) => c.text);
    expect(texts).toContain('Applied.');
  });

  it('ends the turn when the edit is declined', async () => {
    const agent = start({ start: [{ approve: EDIT, after: 'Applied.' }] });
    await agent.waitFor(isPermission);
    answer(agent, 'deny');
    await agent.waitFor(isResult);
    expect(toolResult(agent.messages).is_error).toBe(true);
  });

  it('stops a reply when interrupted', async () => {
    const agent = start({ reply: [{ text: 'Working on it.' }, { stream: 'Still going' }] });
    await agent.waitFor((message) => message.type === 'system');
    agent.send({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Go' } });
    await agent.waitFor((message) => message.message?.content?.[0]?.text === 'Working on it.');
    agent.send({ type: 'control_request', request_id: 'stop', request: { subtype: 'interrupt' } });
    await agent.waitFor(isResult);
    // Past the next step's delay: the rest of the reply must not arrive.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(agent.messages.some((message) => message.type === 'stream_event')).toBe(false);
  });
});
