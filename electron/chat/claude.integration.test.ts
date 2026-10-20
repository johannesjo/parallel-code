import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { ClaudeChat } from './claude.js';

let directory: string | undefined;
let chat: ClaudeChat | undefined;
afterEach(async () => {
  chat?.stop();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('uses the real SDK for streaming, approval, model controls, interruption and disk resume', async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-chat-sdk-')));
  vi.stubEnv('CLAUDE_CONFIG_DIR', directory);
  vi.stubEnv('CLAUDE_CODE_PROJECT_DIR_NAME', '');
  const log = join(directory, 'wire.log');
  const opts = {
    provider: 'claude' as const,
    agentId: 'a',
    command: fileURLToPath(new URL('./fixtures/claude-process.mjs', import.meta.url)),
    cwd: directory,
    env: { ...process.env, CLAUDE_FIXTURE_LOG: log } as Record<string, string>,
  };
  const diagnostics: string[] = [];
  const fixtureSdk = {
    ...sdk,
    query: (args: Parameters<typeof sdk.query>[0]) =>
      sdk.query({
        ...args,
        options: { ...args.options, stderr: (line) => diagnostics.push(line) },
      }),
  };
  chat = new ClaudeChat(fixtureSdk, opts, () => {});
  try {
    await chat.start();
  } catch (error) {
    throw new Error(
      `${String(error)}\n${chat.state.error}\n${diagnostics.join('')}\n${await readFile(log, 'utf8').catch(() => 'No wire log')}`,
    );
  }
  await vi.waitFor(() => expect(chat?.state.model).toBe('claude-fixture'));
  await vi.waitFor(() =>
    expect(chat?.state.contextUsage).toEqual({ usedTokens: 50000, maxTokens: 200000 }),
  );
  await chat.selectModel('claude-fixture', 'high');
  await chat.send('Hello');
  await vi.waitFor(() => expect(chat?.state.status).toBe('ready'));
  expect(
    chat.state.items.filter((item) => item.kind === 'assistant').map((item) => item.text),
  ).toEqual(['Hello from the Claude fixture.']);
  await chat.send('/approval');
  await vi.waitFor(() => expect(chat?.state.requests).toHaveLength(1));
  chat.respond(chat.state.requests[0].id, 'accept');
  await vi.waitFor(() => expect(chat?.state.status).toBe('ready'));
  expect(chat.state.items.find((item) => item.kind === 'tool')?.text).toContain(
    'Approved fixture output',
  );
  await chat.send('/approval');
  await vi.waitFor(() => expect(chat?.state.requests).toHaveLength(1));
  chat.respond(chat.state.requests[0].id, 'decline');
  await vi.waitFor(() => expect(chat?.state.status).toBe('ready'));
  expect(chat.state.items.filter((item) => item.kind === 'tool').pop()?.activity?.status).toBe(
    'declined',
  );
  await chat.send('/question');
  await vi.waitFor(() => expect(chat?.state.requests).toHaveLength(1));
  chat.respond(chat.state.requests[0].id, 'accept', { 'Which features?': 'A, B' });
  await vi.waitFor(() => expect(chat?.state.status).toBe('ready'));
  await chat.send('/slow');
  await chat.interrupt();
  await vi.waitFor(() => expect(chat?.state.status).toBe('ready'));
  await expect(chat.send('/error')).rejects.toThrow('Fixture rejected send');
  const sessionId = chat.state.threadId;

  const history = chat.state.items.filter((item) => item.kind !== 'tool').map((item) => item.text);
  chat.stop();
  chat = new ClaudeChat(sdk, { ...opts, threadId: sessionId }, () => {});
  await chat.start();
  expect(chat.state.threadId).toBe(sessionId);
  expect(chat.state.items.filter((item) => item.kind !== 'tool').map((item) => item.text)).toEqual(
    history,
  );
  await chat.send('After resume');
  await vi.waitFor(() => expect(chat?.state.status).toBe('ready'));
  const wire = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          request?: { subtype: string; settings?: unknown; detail?: string };
        },
    );
  expect(
    wire.find((message) => message.request?.subtype === 'apply_flag_settings')?.request?.settings,
  ).toEqual({ model: 'claude-fixture', effortLevel: 'high' });
  const summaries = wire.filter((message) => message.request?.subtype === 'get_context_usage');
  expect(summaries.length).toBeGreaterThan(1);
  expect(summaries.every((message) => message.request?.detail === 'summary')).toBe(true);
}, 20_000);
