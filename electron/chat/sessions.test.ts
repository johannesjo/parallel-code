import { afterEach, expect, it, vi } from 'vitest';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import {
  findAgentChat,
  getAgentChat,
  listTaskChats,
  onAgentChatsChanged,
  releaseChat,
  startAgentChat,
  stopAgentChat,
  stopAllAgentChats,
} from './sessions.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), start: vi.fn(async () => {}) }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('../ipc/codex-chat.js', () => ({
  CodexChat: class {
    state: AgentChatState = { status: 'starting', items: [], requests: [] };
    observers = new Set<(state: AgentChatState) => void>();
    async start() {
      await mocks.start();
      this.state.status = 'ready';
    }
    subscribe() {}
    observe(listener: (state: AgentChatState) => void) {
      this.observers.add(listener);
      return () => this.observers.delete(listener);
    }
    stop() {
      this.state.status = 'closed';
      for (const listener of this.observers) listener(this.state);
    }
    async release() {
      this.stop();
      return {};
    }
  },
}));

const opts = {
  provider: 'codex' as const,
  agentId: 'agent',
  command: 'codex',
  cwd: '/worktree',
  env: {},
};
afterEach(() => {
  stopAllAgentChats();
  vi.clearAllMocks();
});

it('shares startup, passes canvas configuration, and releases it on handoff', async () => {
  const dispose = vi.fn();
  const prepare = vi.fn(async () => ({
    args: ['--config', 'mcp_servers.parallel-code={}'],
    dispose,
  }));
  const results = await Promise.all([
    startAgentChat(opts, () => {}, prepare),
    startAgentChat(opts, () => {}, prepare),
  ]);
  expect(results).toEqual([{ canvasTools: true }, { canvasTools: true }]);
  expect(prepare).toHaveBeenCalledOnce();
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
    'codex',
    ['app-server', '--config', 'mcp_servers.parallel-code={}'],
    expect.objectContaining({ cwd: '/worktree' }),
  );
  await startAgentChat(opts, () => {}, prepare);
  expect(prepare).toHaveBeenCalledOnce();
  await releaseChat('agent');
  expect(dispose).toHaveBeenCalledOnce();
  stopAgentChat('agent');
  expect(dispose).toHaveBeenCalledOnce();
});

it('cancels startup and revokes resources if the task closes during canvas setup', async () => {
  const dispose = vi.fn();
  let release = () => {};
  const prepare = () =>
    new Promise<{ args: string[]; dispose: () => void }>((resolve) => {
      release = () => resolve({ args: ['--config', 'canvas'], dispose });
    });
  const starting = startAgentChat(opts, () => {}, prepare);
  const reattaching = startAgentChat(opts, () => {}, prepare);
  const rejected = expect(starting).rejects.toThrow('cancelled');
  const reattachRejected = expect(reattaching).rejects.toThrow('cancelled');
  stopAgentChat('agent');
  release();
  await rejected;
  await reattachRejected;
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(() => getAgentChat('agent')).toThrow('Open Chat');
});

it.each([false, true])(
  'rejects handoff during canvas setup, then permits it when ready (reconnect: %s)',
  async (reconnect) => {
    if (reconnect) {
      await startAgentChat(opts, () => {});
      getAgentChat('agent').stop();
      mocks.spawn.mockClear();
    }
    const dispose = vi.fn();
    let finishSetup = () => {};
    const starting = startAgentChat(
      opts,
      () => {},
      () =>
        new Promise((resolve) => {
          finishSetup = () => resolve({ args: [], dispose });
        }),
    );
    try {
      await expect(releaseChat('agent')).rejects.toThrow(
        'Wait for chat startup to finish before switching views.',
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      finishSetup();
      await starting;
    }
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await expect(releaseChat('agent')).resolves.toEqual({});
    expect(dispose).toHaveBeenCalledOnce();
  },
);

it('releases credentials when startup fails and allows a clean retry', async () => {
  const dispose = vi.fn();
  mocks.start.mockRejectedValueOnce(new Error('Startup failed'));
  await expect(
    startAgentChat(
      opts,
      () => {},
      async () => ({ args: [], dispose }),
    ),
  ).rejects.toThrow('Startup failed');
  expect(dispose).toHaveBeenCalledOnce();
  expect(() => getAgentChat('agent')).toThrow('Open Chat');
  await expect(startAgentChat(opts, () => {})).resolves.toEqual({ canvasTools: false });
});

it('releases credentials on an unexpected process exit', async () => {
  const dispose = vi.fn();
  await startAgentChat(
    opts,
    () => {},
    async () => ({ args: [], dispose }),
  );
  getAgentChat('agent').stop();
  expect(dispose).toHaveBeenCalledOnce();
});

it('lists task chats, keeps one that crashed as exited, and reports each change', async () => {
  const changed = vi.fn();
  const stopListening = onAgentChatsChanged(changed);
  try {
    await startAgentChat({ ...opts, taskId: 'task' }, () => {});
    expect(changed).toHaveBeenCalledOnce();
    expect(listTaskChats()).toEqual([{ agentId: 'agent', taskId: 'task', status: 'running' }]);
    expect(findAgentChat('agent')).toBe(getAgentChat('agent'));

    // The process ended on its own; the desktop still shows the transcript.
    getAgentChat('agent').stop();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(listTaskChats()).toEqual([{ agentId: 'agent', taskId: 'task', status: 'exited' }]);

    stopAgentChat('agent');
    expect(changed).toHaveBeenCalledTimes(3);
    expect(listTaskChats()).toEqual([]);
    expect(findAgentChat('agent')).toBeUndefined();
  } finally {
    stopListening();
  }
});

it('reports the list without a chat that failed to start or was released', async () => {
  // What a listener last saw, as a phone would show it.
  let reported: ReturnType<typeof listTaskChats> | undefined;
  const stopListening = onAgentChatsChanged(() => (reported = listTaskChats()));
  try {
    mocks.start.mockRejectedValueOnce(new Error('Startup failed'));
    await expect(startAgentChat({ ...opts, taskId: 'task' }, () => {})).rejects.toThrow();
    expect(reported).toEqual([]);

    await startAgentChat({ ...opts, taskId: 'task' }, () => {});
    expect(reported).toEqual([{ agentId: 'agent', taskId: 'task', status: 'running' }]);
    await releaseChat('agent');
    expect(reported).toEqual([]);
  } finally {
    stopListening();
  }
});

it('keeps chats without a task off the list', async () => {
  await startAgentChat(opts, () => {});
  expect(listTaskChats()).toEqual([]);
  expect(findAgentChat('agent')).toBeDefined();
});
