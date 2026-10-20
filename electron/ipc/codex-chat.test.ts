import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexChat } from './codex-chat.js';

const models = [
  {
    model: 'model-a',
    displayName: 'Model A',
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Faster' },
      { reasoningEffort: 'high', description: 'Deeper' },
    ],
  },
  {
    model: 'model-b',
    displayName: 'Model B',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deeper' },
    ],
  },
];

function harness() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    exitCode: null,
    killed: false,
  });
  const messages: Record<string, unknown>[] = [];
  proc.stdin.on('data', (data: Buffer) =>
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
  );
  const publish = vi.fn();
  const chat = new CodexChat(proc as unknown as ChildProcessWithoutNullStreams, publish);
  const receive = (message: unknown) => proc.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (result: unknown) => receive({ id: messages[messages.length - 1]?.id, result });
  async function start(threadId?: string, turns: unknown[] = [], skills: unknown[] = []) {
    const ready = chat.start('/worktree', threadId);
    expect(messages[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'parallel_code' } },
    });
    reply({});
    await Promise.resolve();
    expect(messages[1]).toEqual({ method: 'initialized' });
    expect(messages[2]).toMatchObject({
      method: threadId ? 'thread/resume' : 'thread/start',
      params: {
        cwd: '/worktree',
        ...(threadId
          ? { threadId }
          : { historyMode: 'legacy', sandbox: 'workspace-write', approvalPolicy: 'on-request' }),
      },
    });
    reply({
      thread: { id: threadId ?? 'thread-1', turns },
      model: 'model-a',
      reasoningEffort: 'high',
    });
    await Promise.resolve();
    expect(messages[messages.length - 1]).toMatchObject({
      method: 'model/list',
      params: { includeHidden: false },
    });
    reply({ data: models, nextCursor: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(messages[messages.length - 1]).toMatchObject({
      method: 'skills/list',
      params: { cwds: ['/worktree'] },
    });
    reply({ data: [{ cwd: '/worktree', skills, errors: [] }] });
    await ready;
  }
  return { proc, chat, messages, receive, reply, start, publish };
}

afterEach(() => vi.useRealTimers());

describe('Codex chat app-server protocol', () => {
  it('discovers enabled skills, sends explicit skill inputs and refreshes changes', async () => {
    const h = harness();
    await h.start(
      undefined,
      [],
      [
        {
          name: 'review',
          path: '/skills/review/SKILL.md',
          description: 'Review code',
          enabled: true,
        },
        { name: 'disabled', path: '/skills/disabled/SKILL.md', enabled: false },
        { name: 'broken' },
      ],
    );
    expect(h.chat.state.commands).toEqual([
      { name: 'review', description: 'Review code', argumentHint: '', prefix: '$' },
    ]);
    const sent = h.chat.send('$review this change');
    expect(h.messages[h.messages.length - 1]).toMatchObject({
      method: 'turn/start',
      params: {
        input: [
          { type: 'text', text: '$review this change' },
          { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
        ],
      },
    });
    h.reply({ turn: { id: 'turn-1' } });
    await sent;
    h.receive({ method: 'skills/changed' });
    expect(h.messages[h.messages.length - 1]).toMatchObject({ method: 'skills/list' });
    h.reply({ data: [{ cwd: '/worktree', skills: [] }] });
    await Promise.resolve();
    expect(h.chat.state.commands).toEqual([]);
    h.receive({ method: 'skills/changed' });
    h.receive({
      id: h.messages[h.messages.length - 1]?.id,
      error: { message: 'Unsupported method' },
    });
    await Promise.resolve();
    expect(h.chat.state.commands).toBeUndefined();
    expect(h.chat.state.status).toBe('working');
    h.chat.stop();
  });

  it('tracks the latest context window separately from session totals and clears unknown limits', async () => {
    const h = harness();
    await h.start();
    const update = (usedTokens: number, limit: number | null) =>
      h.receive({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          tokenUsage: {
            total: { totalTokens: 900000, inputTokens: 800000, outputTokens: 100000 },
            last: { totalTokens: usedTokens },
            modelContextWindow: limit,
          },
        },
      });
    update(150000, 200000);
    expect(h.chat.state.contextUsage).toEqual({ usedTokens: 150000, maxTokens: 200000 });
    update(50000, 200000); // Context shrinks after compaction; session totals do not.
    expect(h.chat.state.contextUsage?.usedTokens).toBe(50000);
    expect(h.chat.state.tokenUsage?.totalTokens).toBe(900000);
    update(210000, 200000);
    expect(h.chat.state.contextUsage?.usedTokens).toBe(210000);
    for (const limit of [null, 0, -1]) {
      update(100, limit);
      expect(h.chat.state.contextUsage).toBeUndefined();
    }
    update(-1, 200000);
    expect(h.chat.state.contextUsage).toBeUndefined();
    update(100, 200000);
    h.chat.selectModel('model-b');
    expect(h.chat.state.contextUsage).toBeUndefined();
    h.chat.stop();
  });

  it('uses cumulative conversation tokens without adding repeated updates', async () => {
    const h = harness();
    await h.start();
    const usage = (totalTokens: number, threadId = 'thread-1') =>
      h.receive({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId,
          tokenUsage: { total: { totalTokens, inputTokens: totalTokens - 100, outputTokens: 100 } },
        },
      });
    usage(1000);
    usage(1000);
    expect(h.chat.state.tokenUsage).toEqual({
      totalTokens: 1000,
      inputTokens: 900,
      outputTokens: 100,
      scope: 'conversation',
    });
    usage(2500);
    usage(9000, 'different-thread');
    usage(-1);
    expect(h.chat.state.tokenUsage?.totalTokens).toBe(2500);
    expect(h.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokenUsage: expect.objectContaining({ totalTokens: 2500 }) }),
    );
    h.chat.stop();
  });

  it('initializes before starting a thread and streams messages without duplicating completed items', async () => {
    const h = harness();
    await h.start();
    expect(h.chat.state.status).toBe('ready');
    const sent = h.chat.send('Fix the tests');
    expect(h.messages[h.messages.length - 1]).toMatchObject({
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Fix the tests' }] },
    });
    h.reply({ turn: { id: 'turn-1' } });
    await sent;
    h.receive({
      method: 'item/started',
      params: {
        item: { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Fix the tests' }] },
      },
    });
    h.receive({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Working' } });
    h.receive({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: ' on it' } });
    h.receive({
      method: 'item/completed',
      params: { item: { id: 'a', type: 'agentMessage', text: 'Working on it' } },
    });
    h.receive({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });
    expect(h.chat.state).toMatchObject({
      status: 'ready',
      items: [
        { id: 'u', kind: 'user', text: 'Fix the tests' },
        { id: 'a', kind: 'assistant', text: 'Working on it' },
      ],
    });
    h.chat.stop();
  });

  it('resumes the exact saved conversation and restores its history', async () => {
    const h = harness();
    await h.start('saved-thread', [
      { items: [{ id: 'a', type: 'agentMessage', text: 'Earlier reply' }] },
    ]);
    expect(h.messages[2]).toMatchObject({ params: { threadId: 'saved-thread' } });
    expect(h.chat.state.items[0]?.text).toBe('Earlier reply');
    h.chat.stop();
  });

  it('tracks command status without changing or duplicating its output', async () => {
    const h = harness();
    await h.start();
    const item = { id: 'cmd', type: 'commandExecution', command: 'npm test', aggregatedOutput: '' };
    h.receive({ method: 'item/started', params: { item: { ...item, status: 'inProgress' } } });
    expect(h.chat.state.items[0]?.activity).toEqual({
      type: 'command',
      command: 'npm test',
      label: 'npm test',
      status: 'running',
    });
    h.receive({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'cmd', delta: 'Failed test' },
    });
    expect(h.chat.state.items[0]?.text).toBe('Failed test');
    h.receive({
      method: 'item/completed',
      params: {
        item: {
          ...item,
          status: 'completed',
          exitCode: 1,
          aggregatedOutput: 'Failed test',
        },
      },
    });
    expect(h.chat.state.items).toHaveLength(1);
    expect(h.chat.state.items[0]).toMatchObject({
      text: 'Failed test',
      activity: { command: 'npm test', status: 'failed', exitCode: 1 },
    });
    h.chat.stop();
  });

  it('restores file changes, declined commands and failed tools from history', async () => {
    const h = harness();
    await h.start('saved', [
      {
        items: [
          {
            id: 'files',
            type: 'fileChange',
            status: 'completed',
            changes: [
              {
                path: 'src/app.ts',
                kind: { type: 'update' },
                diff: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b',
              },
              { path: 'src/new.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' },
            ],
          },
          { id: 'declined', type: 'commandExecution', command: 'npm install', status: 'declined' },
          {
            id: 'tool',
            type: 'mcpToolCall',
            server: 'docs',
            tool: 'search',
            status: 'failed',
            error: { message: 'Unavailable' },
          },
          { id: 'unfinished', type: 'commandExecution', command: 'npm test', status: 'inProgress' },
        ],
      },
    ]);
    expect(h.chat.state.items.map((item) => item.activity)).toEqual([
      {
        type: 'files',
        files: ['src/app.ts', 'src/new.ts'],
        label: '2 files',
        status: 'completed',
        // File headers go; a created file arrives whole and is shown as added.
        diffs: [
          { path: 'src/app.ts', diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1 },
          { path: 'src/new.ts', diff: '@@ -0,0 +1,2 @@\n+one\n+two', added: 2, removed: 0 },
        ],
      },
      { type: 'command', command: 'npm install', label: 'npm install', status: 'declined' },
      { type: 'tool', label: 'docs / search', status: 'failed' },
      { type: 'command', command: 'npm test', label: 'npm test', status: 'interrupted' },
    ]);
    h.chat.stop();
  });

  it.each(['turn/completed', 'disconnect'])(
    'settles unfinished activity on %s without claiming success',
    async (ending) => {
      const h = harness();
      await h.start();
      for (const id of ['finished', 'unfinished']) {
        h.receive({
          method: 'item/started',
          params: { item: { id, type: 'commandExecution', command: id } },
        });
      }
      h.receive({
        method: 'item/completed',
        params: {
          item: {
            id: 'finished',
            type: 'commandExecution',
            command: 'finished',
            status: 'completed',
          },
        },
      });
      if (ending === 'disconnect') h.proc.emit('exit', 1);
      else h.receive({ method: ending, params: { turn: { status: 'interrupted' } } });
      expect(h.chat.state.items.map((item) => item.activity?.status)).toEqual([
        'completed',
        'interrupted',
      ]);
      h.chat.stop();
    },
  );

  it('restores the resolved model and effort and applies a selection to subsequent turns', async () => {
    const h = harness();
    await h.start('saved');
    expect(h.chat.state).toMatchObject({ model: 'model-a', reasoningEffort: 'high', models });
    h.chat.selectModel('model-b');
    expect(h.chat.state).toMatchObject({ model: 'model-b', reasoningEffort: 'medium' });
    h.chat.selectModel('model-b', 'high');
    for (const text of ['First turn', 'Second turn']) {
      const sent = h.chat.send(text);
      expect(h.messages[h.messages.length - 1]).toMatchObject({
        method: 'turn/start',
        params: { model: 'model-b', effort: 'high' },
      });
      expect(() => h.chat.selectModel('model-a')).toThrow('Wait for Codex');
      h.reply({ turn: { id: text } });
      await sent;
      h.receive({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
    h.chat.stop();
  });

  it('rejects unavailable models and incompatible effort without changing the selection', async () => {
    const h = harness();
    await h.start();
    expect(() => h.chat.selectModel('invented-model')).toThrow('not available');
    expect(() => h.chat.selectModel('model-b', 'low')).toThrow('not supported');
    expect(h.chat.state).toMatchObject({ model: 'model-a', reasoningEffort: 'high' });
    h.chat.stop();
    expect(() => h.chat.selectModel('model-b')).toThrow('Wait for Codex');
  });

  it('loads every catalog page and recovers from a failed refresh without losing the current model', async () => {
    const h = harness();
    await h.start();
    const failed = h.chat.loadModels();
    h.receive({
      id: h.messages[h.messages.length - 1]?.id,
      error: { message: 'Catalog unavailable' },
    });
    await failed;
    expect(h.chat.state).toMatchObject({
      status: 'ready',
      model: 'model-a',
      modelsError: 'Catalog unavailable',
    });
    const retry = h.chat.loadModels();
    h.reply({ data: [models[0], { ...models[1], hidden: true }], nextCursor: 'page-2' });
    await Promise.resolve();
    expect(h.messages[h.messages.length - 1]).toMatchObject({
      method: 'model/list',
      params: { cursor: 'page-2' },
    });
    h.reply({ data: [models[1]], nextCursor: null });
    await retry;
    expect(h.chat.state.models).toEqual(models);
    expect(h.chat.state.modelsError).toBeUndefined();
    h.chat.stop();
  });

  it('requires explicit approval, replies with the original request id, and rejects stale responses', async () => {
    const h = harness();
    await h.start();
    h.receive({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test', reason: 'Run outside sandbox?' },
    });
    expect(h.chat.state.requests[0]).toMatchObject({ id: 'approval-1', kind: 'approval' });
    expect(h.messages[h.messages.length - 1]?.id).not.toBe('approval-1');
    h.chat.respond('approval-1', 'decline');
    expect(h.messages[h.messages.length - 1]).toEqual({
      id: 'approval-1',
      result: { decision: 'decline' },
    });
    expect(h.chat.state.requests).toEqual([]);
    expect(() => h.chat.respond('approval-1', 'accept')).toThrow('no longer pending');
    h.chat.stop();
  });

  it('answers an always-allow as a plain accept, a word its app-server knows', async () => {
    const h = harness();
    await h.start();
    h.receive({
      id: 'approval-2',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test' },
    });
    // Codex never offers to remember, so this can only come from a stale card.
    expect(h.chat.state.requests[0].canAlwaysAllow).toBeUndefined();
    h.chat.respond('approval-2', 'accept-always');
    expect(h.messages[h.messages.length - 1]).toEqual({
      id: 'approval-2',
      result: { decision: 'accept' },
    });
    h.chat.stop();
  });

  it('answers structured questions and clears requests resolved by the server', async () => {
    const h = harness();
    await h.start();
    const request = {
      id: 99,
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          {
            id: 'choice',
            question: 'Which approach?',
            options: [{ label: 'Simple', description: 'Smallest change' }],
          },
        ],
      },
    };
    h.receive(request);
    h.chat.respond(99, 'accept', { choice: 'Simple' });
    expect(h.messages[h.messages.length - 1]).toEqual({
      id: 99,
      result: { answers: { choice: { answers: ['Simple'] } } },
    });
    h.receive(request);
    h.receive({ method: 'serverRequest/resolved', params: { requestId: 99 } });
    expect(h.chat.state.requests).toEqual([]);
    h.chat.stop();
  });

  it('interrupts the active turn and refuses overlapping sends', async () => {
    const h = harness();
    await h.start();
    const send = h.chat.send('Work');
    h.reply({ turn: { id: 'turn-1' } });
    await send;
    await expect(h.chat.send('Another')).rejects.toThrow('Wait for Codex');
    const interrupt = h.chat.interrupt();
    expect(h.messages[h.messages.length - 1]).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    h.reply({});
    await interrupt;
    expect(h.chat.state.status).toBe('working');
    h.receive({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
    expect(h.chat.state.status).toBe('ready');
    h.chat.stop();
  });

  it('rejects unsupported server requests instead of hanging or approving them', async () => {
    const h = harness();
    await h.start();
    h.receive({ id: 70, method: 'future/approval', params: {} });
    expect(h.messages[h.messages.length - 1]).toMatchObject({ id: 70, error: { code: -32601 } });
    expect(h.chat.state.error).toContain('unsupported');
    h.chat.stop();
  });

  it('honors Stop even before the turn-start acknowledgement arrives', async () => {
    const h = harness();
    await h.start();
    const sending = h.chat.send('Work');
    await h.chat.interrupt();
    expect(h.messages[h.messages.length - 1]?.method).toBe('turn/start');
    h.reply({ turn: { id: 'turn-1' } });
    await sending;
    expect(h.messages[h.messages.length - 1]).toMatchObject({
      method: 'turn/interrupt',
      params: { turnId: 'turn-1' },
    });
    h.reply({});
    await Promise.resolve();
    h.chat.stop();
  });

  it('does not revive a stopped process when a pending send fails or late events arrive', async () => {
    const h = harness();
    await h.start();
    const sending = h.chat.send('Work');
    h.chat.stop();
    await expect(sending).rejects.toThrow('stopped');
    h.receive({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    expect(h.chat.state.status).toBe('closed');
  });

  it('reports RPC errors and lets the user retry a rejected turn', async () => {
    const h = harness();
    await h.start();
    const sending = h.chat.send('Work');
    h.receive({
      id: h.messages[h.messages.length - 1]?.id,
      error: { message: 'Sign in to Codex first' },
    });
    await expect(sending).rejects.toThrow('Sign in');
    expect(h.chat.state).toMatchObject({ status: 'ready', error: 'Sign in to Codex first' });
    h.chat.stop();
  });

  it('rejects pending requests and clears approvals on process exit', async () => {
    const h = harness();
    const start = h.chat.start('/worktree');
    h.proc.emit('exit', 1);
    await expect(start).rejects.toThrow('disconnected');
    expect(h.chat.state.status).toBe('closed');
    expect(h.chat.state.requests).toEqual([]);
  });

  it('terminates a stalled initialization rather than retaining a pending promise', async () => {
    vi.useFakeTimers();
    const h = harness();
    const starting = h.chat.start('/worktree');
    const rejected = expect(starting).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(h.proc.kill).toHaveBeenCalled();
    expect(h.chat.state.status).toBe('closed');
  });
});

it('waits for the app-server to close before handing its exact session and settings to Terminal', async () => {
  const h = harness();
  await h.start();
  const released = vi.fn();
  const handoff = h.chat.release().then(released);
  await Promise.resolve();
  expect(h.proc.kill).toHaveBeenCalledWith('SIGTERM');
  expect(released).not.toHaveBeenCalled();
  await expect(h.chat.send('Too late')).rejects.toThrow();
  h.proc.emit('close');
  await handoff;
  expect(released).toHaveBeenCalledWith({
    threadId: 'thread-1',
    model: 'model-a',
    reasoningEffort: 'high',
  });
});

it('refuses handoff while a turn or permission request is pending', async () => {
  const h = harness();
  await h.start();
  h.receive({ method: 'turn/started', params: { turn: { id: 'turn' } } });
  await expect(h.chat.release()).rejects.toThrow('Finish or stop');
  h.receive({ method: 'turn/completed', params: { turn: { id: 'turn' } } });
  h.receive({ id: 99, method: 'item/commandExecution/requestApproval', params: {} });
  await expect(h.chat.release()).rejects.toThrow('pending requests');
  expect(h.proc.kill).not.toHaveBeenCalled();
  h.chat.stop();
  h.proc.emit('close');
});

it('sends images as multimodal input and exposes agent plans and interruption state', async () => {
  const h = harness();
  await h.start();
  const sent = h.chat.send('Inspect this', [
    { name: 'screen.png', mediaType: 'image/png', data: 'aGVsbG8=' },
  ]);
  expect(h.messages[h.messages.length - 1]).toMatchObject({
    method: 'turn/start',
    params: {
      input: [
        { type: 'text', text: 'Inspect this' },
        { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
      ],
    },
  });
  h.reply({ turn: { id: 'turn' } });
  await sent;
  h.receive({
    method: 'turn/plan/updated',
    params: {
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Fix', status: 'inProgress' },
      ],
    },
  });
  expect(h.chat.state.plan).toEqual([
    { step: 'Inspect', status: 'completed' },
    { step: 'Fix', status: 'in_progress' },
  ]);
  h.receive({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
  expect(h.chat.state.interrupted).toBe(true);
  expect(h.chat.state.status).toBe('ready');
});

describe('stopping the app-server', () => {
  it('gives the process group a grace period on an ordinary stop', async () => {
    const h = harness();
    await h.start();
    h.chat.stop();
    expect(h.proc.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM']);
  });

  it('kills the group outright when the app is quitting', async () => {
    const h = harness();
    await h.start();
    // On quit the grace timer is unref'd and Electron exits long before 2 s, so a group that
    // ignores SIGTERM would outlive the app with nobody left to kill it.
    h.chat.stop(true);
    expect(h.proc.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
