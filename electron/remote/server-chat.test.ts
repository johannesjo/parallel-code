// Desktop chats over the phone WebSocket: listed in place of their task's
// terminal, readable with the QR-code token, and writable only once paired.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentChat } from '../chat/types.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import type { RemoteAgent, ServerMessage } from './protocol.js';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  subscribeToAgentRendered: vi.fn(() => null),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => ['a1', 'a2']),
  getAgentMeta: vi.fn((agentId: string) => ({ taskId: agentId === 'a1' ? 't1' : 't2' })),
  getAgentCols: vi.fn(() => 80),
  getAgentRows: vi.fn(() => 24),
  onPtyEvent: vi.fn(() => vi.fn()),
}));

const { startRemoteServer } = await import('./server.js');

const state: AgentChatState = {
  status: 'ready',
  items: [{ id: '1', kind: 'assistant', text: 'Done.' }],
  requests: [],
};
const stopObserving = vi.fn();
const chat = { state, observe: vi.fn(() => stopObserving), send: vi.fn(async () => {}) };
// How the desktop lists the chat: running, ended on its own, or gone altogether.
let listed: 'running' | 'exited' | undefined;
let notifyChange = () => {};
let srv: Awaited<ReturnType<typeof startRemoteServer>>;

beforeEach(async () => {
  listed = 'running';
  srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => `Task ${id}`,
    getAgentStatus: () => ({ status: 'running', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    getTaskContext: () => ({
      projectName: 'Project',
      projectColor: '#65d5ff',
      agentName: 'Claude Code',
      lastLine: 'Done.',
    }),
    chats: {
      list: () => (listed ? [{ agentId: 'a1', taskId: 't1', status: listed }] : []),
      find: (agentId) => (listed && agentId === 'a1' ? (chat as unknown as AgentChat) : undefined),
      onChange: (listener) => {
        notifyChange = listener;
        return () => {};
      },
    },
  });
  vi.clearAllMocks();
});
afterEach(() => srv.stop());

function open(token: string): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const messages: ServerMessage[] = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      messages.push(JSON.parse(String(raw)) as ServerMessage);
      if (messages.length === 1) resolve({ ws, messages });
    });
    ws.on('error', reject);
  });
}

async function pairedToken(): Promise<string> {
  const { pin } = srv.generatePairingPin();
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/pair/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${srv.mobileToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  return ((await res.json()) as { token: string }).token;
}

const agentsIn = (messages: ServerMessage[]) =>
  messages.filter((m): m is Extract<ServerMessage, { type: 'agents' }> => m.type === 'agents');

it('lists a running chat in place of its task terminal and updates when chats change', async () => {
  const { ws, messages } = await open(srv.mobileToken);
  const list = agentsIn(messages)[0].list;
  expect(list.find((agent) => agent.taskId === 't1')).toEqual<RemoteAgent>({
    agentId: 'a1',
    taskId: 't1',
    taskName: 'Task t1',
    status: 'running',
    exitCode: null,
    attention: 'idle',
    projectName: 'Project',
    projectColor: '#65d5ff',
    agentName: 'Claude Code',
    lastLine: 'Done.',
    kind: 'chat',
  });
  expect(list.filter((agent) => agent.taskId === 't1')).toHaveLength(1);
  expect(list.find((agent) => agent.taskId === 't2')?.kind).toBeUndefined();
  expect(list.find((agent) => agent.taskId === 't2')?.projectColor).toBe('#65d5ff');

  // A chat that crashed keeps its transcript on the phone, as on the desktop.
  listed = 'exited';
  notifyChange();
  await vi.waitFor(() => expect(agentsIn(messages)).toHaveLength(2));
  expect(agentsIn(messages)[1].list.find((agent) => agent.taskId === 't1')).toMatchObject({
    kind: 'chat',
    status: 'exited',
  });

  listed = undefined;
  notifyChange();
  await vi.waitFor(() => expect(agentsIn(messages)).toHaveLength(3));
  expect(agentsIn(messages)[2].list.find((agent) => agent.taskId === 't1')?.kind).toBeUndefined();
  ws.close();
});

it('ignores chats it does not know and stops observing when the phone disconnects', async () => {
  const { ws, messages } = await open(srv.mobileToken);
  ws.send(JSON.stringify({ type: 'chat-subscribe', agentId: 'unknown' }));
  ws.send(JSON.stringify({ type: 'chat-subscribe', agentId: 'a1' }));
  await vi.waitFor(() => expect(messages.some((m) => m.type === 'chat-state')).toBe(true));
  expect(messages.filter((m) => m.type === 'chat-state')).toEqual([
    expect.objectContaining({ agentId: 'a1' }),
  ]);
  expect(stopObserving).not.toHaveBeenCalled();
  ws.close();
  await vi.waitFor(() => expect(stopObserving).toHaveBeenCalledOnce());
});

it('stops observing a chat that leaves the list while the phone watches it', async () => {
  const { ws, messages } = await open(srv.mobileToken);
  ws.send(JSON.stringify({ type: 'chat-subscribe', agentId: 'a1' }));
  await vi.waitFor(() => expect(messages.some((m) => m.type === 'chat-state')).toBe(true));
  listed = undefined;
  notifyChange();
  expect(stopObserving).toHaveBeenCalledOnce();
  ws.close();
});

describe('QR-code token', () => {
  it('can read a chat but not act on it', async () => {
    const { ws, messages } = await open(srv.mobileToken);
    ws.send(JSON.stringify({ type: 'chat-subscribe', agentId: 'a1' }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'chat-state')).toBe(true));
    expect(messages.find((m) => m.type === 'chat-state')).toMatchObject({ agentId: 'a1', state });

    const closed = new Promise<number>((resolve) => ws.on('close', resolve));
    ws.send(
      JSON.stringify({
        type: 'chat-action',
        agentId: 'a1',
        requestId: '1',
        action: 'send',
        params: { text: 'rm -rf ~' },
      }),
    );
    expect(await closed).toBe(4003);
    expect(chat.send).not.toHaveBeenCalled();
  });
});

describe('paired token', () => {
  it('sends a message and reports failures to the phone', async () => {
    const { ws, messages } = await open(await pairedToken());
    const result = (requestId: string) =>
      vi.waitFor(() => {
        const found = messages.find((m) => m.type === 'input-result' && m.requestId === requestId);
        expect(found).toBeDefined();
        return found;
      });
    ws.send(
      JSON.stringify({
        type: 'chat-action',
        agentId: 'a1',
        requestId: 'ok',
        action: 'send',
        params: { text: 'Ship it' },
      }),
    );
    expect(await result('ok')).toMatchObject({ ok: true });
    expect(chat.send).toHaveBeenCalledWith('Ship it', []);

    ws.send(
      JSON.stringify({
        type: 'chat-action',
        agentId: 'a1',
        requestId: 'empty',
        action: 'send',
        params: { text: '  ' },
      }),
    );
    expect(await result('empty')).toMatchObject({
      ok: false,
      error: expect.stringContaining('Enter a message'),
    });
    ws.close();
  });
});
