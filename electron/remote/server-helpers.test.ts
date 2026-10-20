import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Coordinator } from '../mcp/coordinator.js';
import type { ApiTaskDetail } from '../mcp/types.js';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  subscribeToAgentRendered: vi.fn(() => null),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  getAgentRows: vi.fn(() => 24),
  onPtyEvent: vi.fn(() => vi.fn()),
}));

vi.mock('./protocol.js', () => ({
  parseClientMessage: vi.fn(() => null),
}));

const pty = await import('../ipc/pty.js');
const { requireOwnedTask, readCoordinatorBody, buildAgentList } = await import('./server.js');

type FakeRequest = EventEmitter & { destroy: ReturnType<typeof vi.fn> };

function makeFakeRequest(): FakeRequest {
  const req = new EventEmitter() as FakeRequest;
  req.destroy = vi.fn();
  return req;
}

const task: ApiTaskDetail = {
  id: 'task-a',
  name: 'Task A',
  branchName: 'task/a',
  worktreePath: '/tmp/task-a',
  projectId: 'project-1',
  agentId: 'agent-a',
  status: 'idle',
  coordinatorTaskId: 'coordinator-a',
  exitCode: null,
};

function makeCoordinator(detail: ApiTaskDetail | null): Coordinator {
  return {
    getTaskStatus: vi.fn(() => detail),
  } as unknown as Coordinator;
}

describe('requireOwnedTask', () => {
  it('returns a task owned by the caller without replying', () => {
    const replies: Array<{ status: number; body: unknown }> = [];

    expect(
      requireOwnedTask(makeCoordinator(task), task.id, 'coordinator-a', (status, body) => {
        replies.push({ status, body });
      }),
    ).toBe(task);
    expect(replies).toEqual([]);
  });

  it('replies 404 for missing tasks', () => {
    const replies: Array<{ status: number; body: unknown }> = [];

    expect(
      requireOwnedTask(makeCoordinator(null), 'missing', 'coordinator-a', (status, body) => {
        replies.push({ status, body });
      }),
    ).toBeNull();
    expect(replies).toEqual([{ status: 404, body: { error: 'task not found' } }]);
  });

  it('replies 403 when the caller does not own the task', () => {
    const replies: Array<{ status: number; body: unknown }> = [];

    expect(
      requireOwnedTask(makeCoordinator(task), task.id, 'coordinator-b', (status, body) => {
        replies.push({ status, body });
      }),
    ).toBeNull();
    expect(replies).toEqual([{ status: 403, body: { error: 'forbidden' } }]);
  });
});

describe('readCoordinatorBody', () => {
  it('sends the 413 reply before the connection is torn down', async () => {
    const req = makeFakeRequest();
    const replies: Array<{ status: number; body: unknown }> = [];
    const jsonReply = (status: number, body: unknown) => replies.push({ status, body });

    const pending = readCoordinatorBody(req as unknown as IncomingMessage, jsonReply).catch(
      () => undefined,
    );

    req.emit('data', Buffer.alloc(1_000_001, 'a'));
    await pending;

    expect(replies).toEqual([{ status: 413, body: { error: 'Request body too large' } }]);
    expect(req.destroy).not.toHaveBeenCalled();
  });
});

describe('buildAgentList', () => {
  it('includes active agents and incorporates collapsed tasks', () => {
    vi.mocked(pty.getActiveAgentIds).mockReturnValue(['agent-1']);
    vi.mocked(pty.getAgentMeta).mockImplementation((id) =>
      id === 'agent-1'
        ? ({
            agentId: 'agent-1',
            taskId: 'task-1',
            isShell: false,
            command: 'node',
            args: [],
            cols: 80,
            rows: 24,
            createdAt: Date.now(),
          } as ReturnType<typeof pty.getAgentMeta>)
        : null,
    );

    const getTaskName = (id: string) => (id === 'task-1' ? 'Task 1' : 'Task 2');
    const getAgentStatus = () => ({
      status: 'running' as const,
      exitCode: null,
      lastLine: 'Working...',
    });
    const getTaskAttention = () => 'active' as const;
    const getTaskContext = (id: string) =>
      id === 'task-2'
        ? {
            projectName: 'Proj',
            projectColor: '#fff',
            agentName: 'AgentDef',
            lastLine: 'Last known line',
            taskName: 'Task 2 Name',
            collapsed: true,
          }
        : undefined;
    const getCollapsedTaskIds = () => ['task-2'];

    const agents = buildAgentList(
      getTaskName,
      getAgentStatus,
      getTaskAttention,
      getTaskContext,
      getCollapsedTaskIds,
    );

    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      agentId: 'agent-1',
      taskId: 'task-1',
      taskName: 'Task 1',
      status: 'running',
    });
    expect(agents[1]).toMatchObject({
      agentId: 'collapsed:task-2',
      taskId: 'task-2',
      taskName: 'Task 2 Name',
      projectName: 'Proj',
      status: 'exited',
      collapsed: true,
      lastLine: 'Last known line',
    });
  });

  it('marks existing agents as collapsed if present in getCollapsedTaskIds', () => {
    vi.mocked(pty.getActiveAgentIds).mockReturnValue(['agent-1']);
    vi.mocked(pty.getAgentMeta).mockImplementation(
      () =>
        ({
          agentId: 'agent-1',
          taskId: 'task-1',
          isShell: false,
        }) as ReturnType<typeof pty.getAgentMeta>,
    );

    const agents = buildAgentList(
      () => 'Task 1',
      () => ({ status: 'running', exitCode: null, lastLine: '' }),
      () => 'idle',
      undefined,
      () => ['task-1'],
    );

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agentId: 'agent-1',
      taskId: 'task-1',
      collapsed: true,
    });
  });
});
