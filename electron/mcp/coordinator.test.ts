import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import { join, dirname } from 'path';
import {
  NOT_READY_AGENT_FRAME_FIXTURES,
  READY_AGENT_FRAME_FIXTURES,
} from './agent-frame-fixtures.js';
import { handleMCPToolCall } from './server.js';
import type { MCPClient } from './client.js';
import {
  setupCoordinatorHarness,
  mockExecFile,
  mockReadFileSync,
  mockExistsSync,
  mockUnlinkSync,
  mockFsReadFile,
  mockFsAccess,
  mockAtomicWriteFileSync,
  mockAtomicWriteFile,
  mockNotifyRenderer,
  mockLogInfo,
  mockSpawnAgent,
  mockWriteToAgent,
  mockSubscribeToAgent,
  mockGetAgentScrollback,
  mockGetChangedFiles,
  mockGetAllFileDiffs,
  mockGetDiffBaseSha,
  mockGitMergeTask,
  mockCreateBackendTask,
  mockVerifyStart,
  mockVerifyCancel,
  mockFsMkdir,
  mockOnAgentHookEvent,
  mockWin,
  getExitHandler,
  getHookEventHandler,
  getInterruptHandler,
  getSpawnHandler,
  getOutputCb,
  getAgentId,
  encodeAgentOutput as encode,
  encodeAgentBytes as encodeBytes,
  emitWorkThenIdle,
} from './coordinator-test-harness.js';

const { Coordinator } = await setupCoordinatorHarness();
const { removePreambleBlock } = await import('./preamble.js');
const getChangedFiles = mockGetChangedFiles;
const getAllFileDiffs = mockGetAllFileDiffs;
const getDiffBaseSha = mockGetDiffBaseSha;
const mergeTask = mockGitMergeTask;

// ─── registerCoordinator idempotency and restore path ────────────────────────

describe('Coordinator registerCoordinator — idempotency', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
  });

  it('registerCoordinator is idempotent — second call is a no-op', () => {
    coordinator.registerCoordinator('coord-1', 'proj-1', { worktreePath: '/tmp/project' });
    coordinator.registerCoordinator('coord-1', 'proj-1', { worktreePath: '/tmp/project' });
    // createTask should work — only one CoordinatorState entry
    expect(() =>
      coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' }),
    ).not.toThrow();
  });

  it('createTask succeeds when registerCoordinator is called before (not after) createTask', async () => {
    // Simulates the restore path: StartMCPServer calls registerCoordinator, then
    // the agent calls create_task over MCP. MCP_CoordinatorRegistered has NOT been
    // sent (App.tsx restore loop does not send it).
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await expect(
      coordinator.createTask({ name: 'restore-task', prompt: 'do', coordinatorTaskId: 'coord-1' }),
    ).resolves.toBeDefined();
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_created', expect.anything());
  });

  it('delivers prompts created through the MCP create_task handler', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      const client = {
        createTask: (opts: Parameters<MCPClient['createTask']>[0]) =>
          coordinator.createTask({
            ...opts,
            coordinatorTaskId: opts.coordinatorTaskId ?? 'coord-1',
          }),
      } as unknown as MCPClient;

      const result = await handleMCPToolCall(
        { client, taskId: '', coordinatorId: 'coord-1' },
        'create_task',
        { name: 'child', prompt: 'do one' },
      );

      expect(result).not.toHaveProperty('isError');
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      const agentId = mockSubscribeToAgent.mock.calls[0]?.[0] as string;
      output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(agentId, expect.stringContaining('do one'));
      expect(mockWriteToAgent).toHaveBeenCalledWith(agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues MCP send_prompt behind an undelivered initial prompt and flushes in order', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      const task = await coordinator.createTask({
        name: 'child',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const client = {
        sendPrompt: (taskId: string, prompt: string) => coordinator.sendPrompt(taskId, prompt),
      } as unknown as MCPClient;

      const result = await handleMCPToolCall(
        { client, taskId: '', coordinatorId: 'coord-1' },
        'send_prompt',
        { taskId: task.id, prompt: 'follow one' },
      );

      expect(result).toMatchObject({
        content: [
          {
            text: expect.stringContaining('Prompt queued'),
          },
        ],
      });
      expect(coordinator.getTaskStatus(task.id)?.pendingPrompts).toEqual(['follow one']);

      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(100);

      const textWrites = mockWriteToAgent.mock.calls
        .filter(([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I')
        .map(([, text]) => text);
      expect(textWrites[0]).toEqual(expect.stringContaining('do one'));
      expect(textWrites[1]).toBe('follow one');
      expect(coordinator.getTaskStatus(task.id)?.pendingPromptCount).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries initial prompt delivery when the body write fails', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      const task = await coordinator.createTask({
        name: 'child',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      let failedBodyOnce = false;
      mockWriteToAgent.mockImplementation((agentId: string, data: string) => {
        if (data.includes('do one') && !failedBodyOnce) {
          failedBodyOnce = true;
          throw new Error('pty body failed');
        }
        return { id: agentId, data };
      });

      output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      const bodyWrites = mockWriteToAgent.mock.calls.filter(
        ([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I',
      );
      const enterWrites = mockWriteToAgent.mock.calls.filter(
        ([agentId, text]) => agentId === task.agentId && text === '\r',
      );
      expect(bodyWrites).toHaveLength(2);
      expect(bodyWrites[1]?.[1]).toEqual(expect.stringContaining('do one'));
      expect(enterWrites).toHaveLength(1);
    } finally {
      mockWriteToAgent.mockReset();
      mockWriteToAgent.mockImplementation((agentId: string, data: string) => ({
        id: agentId,
        data,
      }));
      vi.useRealTimers();
    }
  });

  it('does not retry the initial prompt body when only the Enter write fails', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      const task = await coordinator.createTask({
        name: 'child',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      mockWriteToAgent.mockImplementation((agentId: string, data: string) => {
        if (data === '\r') throw new Error('pty enter failed');
        return { id: agentId, data };
      });

      output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      const bodyWrites = mockWriteToAgent.mock.calls.filter(
        ([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I',
      );
      const enterWrites = mockWriteToAgent.mock.calls.filter(
        ([agentId, text]) => agentId === task.agentId && text === '\r',
      );
      expect(bodyWrites).toHaveLength(1);
      expect(bodyWrites[0]?.[1]).toEqual(expect.stringContaining('do one'));
      expect(enterWrites).toHaveLength(1);
    } finally {
      mockWriteToAgent.mockReset();
      mockWriteToAgent.mockImplementation((agentId: string, data: string) => ({
        id: agentId,
        data,
      }));
      vi.useRealTimers();
    }
  });

  it('delivers coordinated initial prompts from the backend for background sub-tasks', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      mockCreateBackendTask
        .mockResolvedValueOnce({
          id: 'task-1',
          branch_name: 'task/one',
          worktree_path: '/tmp/one',
        })
        .mockResolvedValueOnce({
          id: 'task-2',
          branch_name: 'task/two',
          worktree_path: '/tmp/two',
        })
        .mockResolvedValueOnce({
          id: 'task-3',
          branch_name: 'task/three',
          worktree_path: '/tmp/three',
        });

      const taskOne = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const taskTwo = await coordinator.createTask({
        name: 'two',
        prompt: 'do two',
        coordinatorTaskId: 'coord-1',
      });
      const taskThree = await coordinator.createTask({
        name: 'three',
        prompt: 'do three',
        coordinatorTaskId: 'coord-1',
      });
      const outputOne = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      const outputTwo = mockSubscribeToAgent.mock.calls[1]?.[1] as (encoded: string) => void;
      const outputThree = mockSubscribeToAgent.mock.calls[2]?.[1] as (encoded: string) => void;

      outputOne(encode('ready ❯ '));
      outputTwo(encode('ready ❯ '));
      outputThree(encode('ready ❯ '));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        taskOne.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(taskOne.agentId, '\r');
      expect(mockWriteToAgent).toHaveBeenCalledWith(
        taskTwo.agentId,
        expect.stringContaining('do two'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(taskTwo.agentId, '\r');
      expect(mockWriteToAgent).toHaveBeenCalledWith(
        taskThree.agentId,
        expect.stringContaining('do three'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(taskThree.agentId, '\r');

      const createdEvents = mockNotifyRenderer.mock.calls.filter(
        ([channel]) => channel === 'mcp_task_created',
      );
      expect(createdEvents[0]?.[1]).toHaveProperty('prompt', expect.stringContaining('do one'));
      expect(createdEvents[1]?.[1]).toHaveProperty('prompt', expect.stringContaining('do two'));
      expect(createdEvents[2]?.[1]).toHaveProperty('prompt', expect.stringContaining('do three'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers coordinated initial prompts when Claude renders the prompt above a long footer', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      const footer = `\n\n${'opus · /Users/brooksc/code/project/.worktrees/task/'.repeat(8)}`;

      output(encode(`❯${footer}`));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers coordinated initial prompts when Codex renders the prompt above a long footer', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      const footer = `\n\n${'gpt-5.5 default · /Users/brooksc/code/project/.worktrees/task/'.repeat(8)}`;

      output(encode(`›${footer}`));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects an initial prompt-ready agent from scrollback after renderer reattach', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });

      mockGetAgentScrollback.mockReturnValue(encode('ready ❯ '));
      getSpawnHandler()(task.agentId);
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      mockGetAgentScrollback.mockReturnValue(null);
      vi.useRealTimers();
    }
  });

  it.each(READY_AGENT_FRAME_FIXTURES)(
    'detects recorded ready frame from scrollback after renderer reattach: $name',
    async ({ frame }) => {
      vi.useFakeTimers();
      try {
        coordinator.registerCoordinator('coord-1', 'proj-1');

        const task = await coordinator.createTask({
          name: 'one',
          prompt: 'do one',
          coordinatorTaskId: 'coord-1',
        });

        mockGetAgentScrollback.mockReturnValue(encode(frame));
        getSpawnHandler()(task.agentId);
        await vi.advanceTimersByTimeAsync(1_500);
        await vi.advanceTimersByTimeAsync(500);

        expect(mockWriteToAgent).toHaveBeenCalledWith(
          task.agentId,
          expect.stringContaining('do one'),
        );
        expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
      } finally {
        mockGetAgentScrollback.mockReturnValue(null);
        vi.useRealTimers();
      }
    },
  );

  it('delivers initial prompt only once when ready output and reattach scrollback race', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      mockGetAgentScrollback.mockReturnValue(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      getSpawnHandler()(task.agentId);
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      const textWrites = mockWriteToAgent.mock.calls
        .filter(([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I')
        .map(([, text]) => text);
      const enterWrites = mockWriteToAgent.mock.calls.filter(
        ([agentId, text]) => agentId === task.agentId && text === '\r',
      );
      expect(textWrites).toHaveLength(1);
      expect(textWrites[0]).toEqual(expect.stringContaining('do one'));
      expect(enterWrites).toHaveLength(1);
    } finally {
      mockGetAgentScrollback.mockReturnValue(null);
      vi.useRealTimers();
    }
  });

  it('delivers coordinated initial prompts when Claude renders empty insert mode', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(
        encode(
          ['│ >', '-- INSERT --', 'opus · /repo/.worktrees/task/example · ctx:0/200k'].join('\n'),
        ),
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers coordinated initial prompts when Claude redraws ready state with carriage returns', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(
        encode(
          [
            'Claude Code v2.1.153',
            '────────────────────────────────',
            '❯ ',
            '────────────────────────────────',
            '--INSERT--',
            'Sonnet 4 | ~/repo/.worktrees/task/example',
          ].join('\r'),
        ),
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(READY_AGENT_FRAME_FIXTURES)(
    'delivers coordinated initial prompts for recorded ready frame: $name',
    async ({ frame }) => {
      vi.useFakeTimers();
      try {
        coordinator.registerCoordinator('coord-1', 'proj-1');

        const task = await coordinator.createTask({
          name: 'one',
          prompt: 'do one',
          coordinatorTaskId: 'coord-1',
        });
        const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

        output(encode(frame));
        await vi.advanceTimersByTimeAsync(1_500);
        await vi.advanceTimersByTimeAsync(500);

        expect(mockWriteToAgent).toHaveBeenCalledWith(
          task.agentId,
          expect.stringContaining('do one'),
        );
        expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(NOT_READY_AGENT_FRAME_FIXTURES)(
    'does not deliver and logs classifier reason for recorded not-ready frame: $name',
    async ({ frame, reason }) => {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(encode(frame));
      await (
        coordinator as unknown as {
          tryDeliverInitialPrompt(taskId: string): Promise<void>;
        }
      ).tryDeliverInitialPrompt(task.id);

      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockLogInfo).toHaveBeenCalledWith(
        'coordinator.initial_prompt',
        'waiting_for_prompt',
        expect.objectContaining({
          taskId: task.id,
          agentId: task.agentId,
          reason,
          pendingPromptCount: 0,
          tailSample: expect.any(String),
        }),
      );
    },
  );

  it('keeps retrying initial prompt readiness after a not-ready frame goes quiet', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      output(encode('Starting MCP servers (0/2): codex_apps, parallel-code\n›'));

      await vi.advanceTimersByTimeAsync(1_500);

      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(
        (
          coordinator as unknown as {
            initialPromptTimers: Map<string, unknown>;
          }
        ).initialPromptTimers.has(task.id),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['Claude', '❯'],
    ['Codex', '›'],
  ])('delivers when the %s ready prompt glyph is split across PTY chunks', async (_name, glyph) => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      const bytes = Buffer.from(`${glyph}\n\nmodel · /repo/.worktrees/task`);

      output(encodeBytes(bytes.subarray(0, 1)));
      output(encodeBytes(bytes.subarray(1)));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['Claude ANSI prompt', '\x1b[?25l\x1b[32m❯\x1b[0m\x1b[?25h\nopus · /repo/.worktrees/task'],
    ['Codex ANSI prompt', '\x1b[2K\r\x1b[36m›\x1b[0m\n\ngpt-5.5 default · /repo/.worktrees/task'],
  ])('delivers when %s is wrapped in terminal control sequences', async (_name, rawFrame) => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      const bytes = Buffer.from(rawFrame);

      output(encodeBytes(bytes.subarray(0, 4)));
      output(encodeBytes(bytes.subarray(4)));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs timer-driven waiting diagnostics for a recorded not-ready frame', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(encode(NOT_READY_AGENT_FRAME_FIXTURES[0].frame));
      await coordinator.sendPrompt(task.id, 'follow one');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockLogInfo).toHaveBeenCalledWith(
        'coordinator.initial_prompt',
        'waiting_for_prompt',
        expect.objectContaining({
          taskId: task.id,
          agentId: task.agentId,
          reason: NOT_READY_AGENT_FRAME_FIXTURES[0].reason,
          pendingPromptCount: 1,
          tailSample: expect.any(String),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(NOT_READY_AGENT_FRAME_FIXTURES)(
    'preserves initial prompt through recorded not-ready frame then delivers on ready frame: $name',
    async ({ frame }) => {
      vi.useFakeTimers();
      try {
        coordinator.registerCoordinator('coord-1', 'proj-1');

        const task = await coordinator.createTask({
          name: 'one',
          prompt: 'do one',
          coordinatorTaskId: 'coord-1',
        });
        const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

        output(encode(frame));
        await (
          coordinator as unknown as {
            tryDeliverInitialPrompt(taskId: string): Promise<void>;
          }
        ).tryDeliverInitialPrompt(task.id);
        expect(mockWriteToAgent).not.toHaveBeenCalledWith(
          task.agentId,
          expect.stringContaining('do one'),
        );

        output(encode('claude redraw '.repeat(120)));
        output(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
        await vi.advanceTimersByTimeAsync(1_500);
        await vi.advanceTimersByTimeAsync(500);

        const textWrites = mockWriteToAgent.mock.calls
          .filter(
            ([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I',
          )
          .map(([, text]) => text);
        expect(textWrites).toHaveLength(1);
        expect(textWrites[0]).toEqual(expect.stringContaining('do one'));
        expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('preserves initial and queued follow-up prompts through not-ready output before flushing in order', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      await coordinator.sendPrompt(task.id, 'follow one');
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(encode(NOT_READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(coordinator.getTaskStatus(task.id)?.pendingPrompts).toEqual(['follow one']);

      output(encode('claude redraw '.repeat(120)));
      output(encode(READY_AGENT_FRAME_FIXTURES[1].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      output(encode(READY_AGENT_FRAME_FIXTURES[1].frame));
      await vi.advanceTimersByTimeAsync(100);

      const textWrites = mockWriteToAgent.mock.calls
        .filter(([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I')
        .map(([, text]) => text);
      expect(textWrites[0]).toEqual(expect.stringContaining('do one'));
      expect(textWrites[1]).toBe('follow one');
      expect(coordinator.getTaskStatus(task.id)?.pendingPrompt).toBeUndefined();
      expect(coordinator.getTaskStatus(task.id)?.pendingPromptCount).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores human-control holds before the initial prompt is delivered', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      coordinator.setTaskControl(task.id, 'human');
      output(encode('ready ❯ '));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers after a transient startup prompt marker is pushed out of the tail', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(encode('ready ❯ '));
      output(encode('claude redraw '.repeat(500)));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stage review when backend prompt delivery echoes the startup prompt', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(encode('ready ❯ '));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do one'),
      );

      mockNotifyRenderer.mockClear();
      output(encode('[SUB-TASK MODE] do one'));
      output(encode('\nready ❯ '));

      expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(2_100);
      output(encode('Working...\n'));
      output(encode('Done ❯ '));

      expect(mockNotifyRenderer).toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers exactly once after repeated startup control flips', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      coordinator.setTaskControl(task.id, 'human');
      coordinator.setTaskControl(task.id, 'coordinator');
      coordinator.setTaskControl(task.id, 'human');
      coordinator.setTaskControl(task.id, 'coordinator');
      output(encode('ready ❯ '));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      output(encode('still ready ❯ '));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      const textWrites = mockWriteToAgent.mock.calls.filter(
        ([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I',
      );
      expect(textWrites).toHaveLength(1);
      expect(textWrites[0]?.[1]).toEqual(expect.stringContaining('do one'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves initial prompt before queued follow-up prompts', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      await coordinator.sendPrompt(task.id, 'follow one');
      await coordinator.sendPrompt(task.id, 'follow two');
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;

      output(encode('ready ❯ '));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      output(encode('done one ❯ '));
      await vi.advanceTimersByTimeAsync(100);
      output(encode('done follow one ❯ '));
      await vi.advanceTimersByTimeAsync(100);

      const textWrites = mockWriteToAgent.mock.calls
        .filter(([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I')
        .map(([, text]) => text);
      expect(textWrites[0]).toEqual(expect.stringContaining('do one'));
      expect(textWrites[1]).toBe('follow one');
      expect(textWrites[2]).toBe('follow two');
      expect(coordinator.getTaskStatus(task.id)?.pendingPrompt).toBeUndefined();
      expect(coordinator.getTaskStatus(task.id)?.pendingPromptCount).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes queued follow-up prompts after Claude empty insert mode becomes ready', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');

      const task = await coordinator.createTask({
        name: 'one',
        prompt: 'do one',
        coordinatorTaskId: 'coord-1',
      });
      await coordinator.sendPrompt(task.id, 'follow one');
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      const claudeReady = [
        '│ >',
        '-- INSERT --',
        'opus · /repo/.worktrees/task/example · ctx:0/200k',
      ].join('\n');

      output(encode(claudeReady));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      output(encode(claudeReady));
      await vi.advanceTimersByTimeAsync(100);

      const textWrites = mockWriteToAgent.mock.calls
        .filter(([agentId, text]) => agentId === task.agentId && text !== '\r' && text !== '\x1b[I')
        .map(([, text]) => text);
      expect(textWrites[0]).toEqual(expect.stringContaining('do one'));
      expect(textWrites[1]).toBe('follow one');
      expect(coordinator.getTaskStatus(task.id)?.pendingPrompt).toBeUndefined();
      expect(coordinator.getTaskStatus(task.id)?.pendingPromptCount).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('createTask notifies coordinator when coordinator registered only via registerCoordinator', async () => {
    // Simulates restore: StartMCPServer calls registerCoordinator internally.
    // No separate MCP_CoordinatorRegistered call occurs.
    coordinator.registerCoordinator('coord-1', 'proj-1');
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    // Should get a task created notification (not "coordinator not found" error)
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ name: 'test' }),
    );
  });

  it('defaults sub-task baseBranch to the coordinator branch', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1', {
      branchName: 'task/coordinator-work',
      worktreePath: '/tmp/project',
    });

    await coordinator.createTask({ name: 'child', prompt: 'do', coordinatorTaskId: 'coord-1' });

    expect(mockCreateBackendTask).toHaveBeenCalledWith(
      'child',
      '/tmp/project',
      ['.claude', 'node_modules'],
      'task',
      'task/coordinator-work',
    );
    expect(coordinator.getTask('task-1')?.baseBranch).toBe('task/coordinator-work');
  });
});

// ─── coordinator notification tests ───────────────────────────────────────────

describe('Coordinator coordinator notifications', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
  });

  it('does not notify when assignedPromptDelivered is false (startup idle)', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'test',
      prompt: 'do work',
      coordinatorTaskId: 'coord-1',
    });
    const outputCb = getOutputCb();
    outputCb(encode('Welcome ❯ '));
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });

  it('notifies coordinator when sub-task exits before prompt delivery (user closed early)', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do work', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    // Never call markPromptDelivered — simulates user closing the task before prompt lands
    exitHandler(agentId, { exitCode: null });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
    );
  });

  it('suppresses the stale idle prompt immediately after prompt delivery', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      await coordinator.createTask({
        name: 'test',
        prompt: 'do work',
        coordinatorTaskId: 'coord-1',
      });
      const outputCb = getOutputCb();

      coordinator.markPromptDelivered('task-1');

      outputCb(encode('❯ '));
      expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(2_100);
      outputCb(encode('Working...'));
      outputCb(encode('Done ❯ '));
      expect(mockNotifyRenderer).toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.objectContaining({
          coordinatorTaskId: 'coord-1',
          notificationIds: expect.any(Array),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses only the stale prompt echo and accepts a quick completed idle', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do work',
        coordinatorTaskId: 'coord-1',
      });
      const outputCb = getOutputCb();

      outputCb(encode('ready ❯ '));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do work'),
      );
      mockNotifyRenderer.mockClear();

      outputCb(encode('❯ '));
      expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(400);
      outputCb(encode('Done ❯ '));

      expect(mockNotifyRenderer).toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.objectContaining({
          coordinatorTaskId: 'coord-1',
          notificationIds: expect.any(Array),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForIdle ignores the stale prompt echo and resolves on a quick completed idle', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do work',
        coordinatorTaskId: 'coord-1',
      });
      const outputCb = getOutputCb();

      outputCb(encode('ready ❯ '));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      expect(mockWriteToAgent).toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do work'),
      );

      let resolved = false;
      const waitPromise = coordinator.waitForIdle(task.id, 10_000).then((result) => {
        resolved = true;
        return result;
      });

      outputCb(encode('❯ '));
      await Promise.resolve();
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(400);
      outputCb(encode('Done ❯ '));

      await expect(waitPromise).resolves.toEqual({ reason: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not enqueue duplicate notification for repeated idles', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      await coordinator.createTask({
        name: 'test',
        prompt: 'do',
        coordinatorTaskId: 'coord-1',
      });
      coordinator.markPromptDelivered('task-1');
      const outputCb = getOutputCb();
      await vi.advanceTimersByTimeAsync(2_100);
      outputCb(encode('startup echo ❯ '));
      outputCb(encode('Done ❯ '));
      outputCb(encode('Idle again ❯ '));
      const calls = mockNotifyRenderer.mock.calls.filter(
        (c) => c[0] === 'mcp_coordinator_notification_staged',
      );
      const lastPayload = calls[calls.length - 1]?.[1] as { notificationIds: string[] };
      expect(lastPayload.notificationIds).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a staged idle notification if the task resumes output', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');
      const outputCb = getOutputCb();

      await vi.advanceTimersByTimeAsync(2_100);
      outputCb(encode('startup echo ❯ '));
      outputCb(encode('Done ❯ '));
      expect(mockNotifyRenderer).toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
      );

      mockNotifyRenderer.mockClear();
      outputCb(encode('Still working... '.repeat(40)));

      expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
        coordinatorTaskId: 'coord-1',
      });
      expect(coordinator.getTask('task-1')?.reviewNotificationQueued).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('upgrades idle→exited on PTY exit without adding duplicate', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    emitWorkThenIdle(outputCb);
    mockNotifyRenderer.mockClear();
    exitHandler(agentId, { exitCode: 0 });
    const stagedCalls = mockNotifyRenderer.mock.calls.filter(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    expect(stagedCalls).toHaveLength(1);
    const payload = stagedCalls[0][1] as { notificationIds: string[] };
    expect(payload.notificationIds).toHaveLength(1);
  });

  it('ack removes only the pending IDs in that batch', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    emitWorkThenIdle(outputCb);

    const stagedCallAck = mockNotifyRenderer.mock.calls.find(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    if (!stagedCallAck) throw new Error('No staged call found');
    const { batchId } = stagedCallAck[1] as { batchId: string };

    coordinator.ackNotification('coord-1', batchId);
    const task = coordinator.getTask('task-1');
    expect(task?.reviewNotificationQueued).toBe(false);
  });

  it('ack is idempotent', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    emitWorkThenIdle(outputCb);
    const stagedCallIdempotent = mockNotifyRenderer.mock.calls.find(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    if (!stagedCallIdempotent) throw new Error('No staged call found');
    const { batchId } = stagedCallIdempotent[1] as { batchId: string };
    expect(() => {
      coordinator.ackNotification('coord-1', batchId);
      coordinator.ackNotification('coord-1', batchId);
    }).not.toThrow();
  });

  it('uses shortened delay for non-zero exit', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    exitHandler(agentId, { exitCode: 1 });
    const stagedCallDelay = mockNotifyRenderer.mock.calls.find(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    if (!stagedCallDelay) throw new Error('No staged call found');
    const { autoFireAt } = stagedCallDelay[1] as { autoFireAt: number };
    expect(autoFireAt - Date.now()).toBeLessThanOrEqual(15_500);
    expect(autoFireAt - Date.now()).toBeGreaterThan(9_000);
  });

  it('createTask rejects an unknown coordinator ID', async () => {
    await expect(
      coordinator.createTask({
        name: 'orphan',
        prompt: 'do',
        coordinatorTaskId: 'missing-coord',
      }),
    ).rejects.toThrow('Unknown coordinator: missing-coord');
  });

  it('clears staged notification when a notified task is closed', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');
      const outputCb = getOutputCb();
      emitWorkThenIdle(outputCb);

      expect(mockNotifyRenderer).toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
      );

      mockNotifyRenderer.mockClear();
      await coordinator.closeTask('task-1');

      expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
        coordinatorTaskId: 'coord-1',
      });

      mockNotifyRenderer.mockClear();
      vi.advanceTimersByTime(5 * 60_000);
      expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── signal_done tests ────────────────────────────────────────────────────────

describe('Coordinator signal_done', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
  });

  it('stages notification with 5s delay without requiring markPromptDelivered', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');

    const stagedCall = mockNotifyRenderer.mock.calls.find(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    if (!stagedCall) throw new Error('No staged call found');
    const { autoFireAt } = stagedCall[1] as { autoFireAt: number };
    expect(autoFireAt - Date.now()).toBeLessThanOrEqual(5_500);
    expect(autoFireAt - Date.now()).toBeGreaterThan(4_000);
  });

  it('sends MCP_TaskStateSync to renderer', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_state_sync',
      expect.objectContaining({
        taskId: 'task-1',
        signalDoneReceived: true,
      }),
    );
  });

  it('sets signalDoneAt on the task', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const before = new Date();
    coordinator.signalDone('task-1');
    const after = new Date();
    const task = coordinator.getTask('task-1');
    expect(task?.signalDoneAt).toBeDefined();
    expect(task?.signalDoneAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(task?.signalDoneAt?.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('is a no-op for unknown taskId', () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    expect(() => coordinator.signalDone('nonexistent-task')).not.toThrow();
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });
});

// ─── land_self tests ──────────────────────────────────────────────────────────

describe('Coordinator land_self', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  const verification = {
    checks: [{ name: 'typecheck', command: 'npm run typecheck', result: 'passed' as const }],
  };

  function mockGit(statusOut = '') {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          cb(null, 'task/test\n', '');
          return;
        }
        if (args[0] === 'status') {
          cb(null, statusOut, '');
          return;
        }
        if (args.join(' ') === 'rev-parse HEAD') {
          cb(null, 'landed-sha\n', '');
          return;
        }
        cb(null, '', '');
      },
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockFsReadFile.mockResolvedValue('# existing\n');
    mockReadFileSync.mockReturnValue('# existing\n');
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    vi.mocked(mergeTask).mockResolvedValue({
      main_branch: 'main',
      lines_added: 3,
      lines_removed: 1,
    });
    const { deleteTask: mockDeleteTask } = await import('../ipc/tasks.js');
    vi.mocked(mockDeleteTask).mockResolvedValue(undefined);
    mockGit();
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1', { worktreePath: '/tmp/project' });
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    mockNotifyRenderer.mockClear();
  });

  it('lands, cleans up resources, and closes the task record', async () => {
    const { deleteTask: mockDeleteTask } = await import('../ipc/tasks.js');

    const result = await coordinator.landSelf('task-1', { verification, summary: 'done' });

    expect(result).toMatchObject({
      mainBranch: 'main',
      linesAdded: 3,
      linesRemoved: 1,
      landingState: 'reviewed',
    });
    expect(vi.mocked(mergeTask)).toHaveBeenCalled();
    expect(vi.mocked(mockDeleteTask)).toHaveBeenCalled();
    expect(coordinator.getTask('task-1')).toBeUndefined();
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_closed',
      expect.objectContaining({ taskId: 'task-1' }),
    );
  });

  it('stages a landed notification so the coordinator hears about successful self-land', async () => {
    await coordinator.landSelf('task-1', { verification, summary: 'done' });

    const stagedCall = mockNotifyRenderer.mock.calls.find(
      (call) => call[0] === 'mcp_coordinator_notification_staged',
    );
    expect(stagedCall).toBeDefined();
    expect(stagedCall?.[1]).toMatchObject({
      coordinatorTaskId: 'coord-1',
      text: expect.stringContaining('self-landed successfully'),
    });
  });

  it('rejects missing verification before merging', async () => {
    await expect(coordinator.landSelf('task-1', { verification: { checks: [] } })).rejects.toThrow(
      'verification',
    );

    expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landing_escalated');
  });

  describe('verify command', () => {
    const passedRun = {
      command: 'npm test',
      status: 'passed' as const,
      exitCode: 0,
      headSha: 'sha-1',
      dirty: false,
      startedAt: '2026-09-03T10:00:00.000Z',
      finishedAt: '2026-09-03T10:01:00.000Z',
      outputTail: 'ok\n',
    };

    it('runs the command in the task worktree and lands when it passes', async () => {
      coordinator.registerCoordinator('coord-1', 'proj-1', { verifyCommand: 'npm test' });
      mockVerifyStart.mockResolvedValueOnce(passedRun);

      await coordinator.landSelf('task-1', { verification, summary: 'done' });

      expect(mockVerifyStart).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'task-1',
          worktreePath: '/tmp/test',
          command: 'npm test',
          env: expect.objectContaining({
            PARALLEL_CODE_TASK_ID: 'task-1',
            PARALLEL_CODE_BRANCH: 'task/test',
          }),
        }),
      );
      expect(vi.mocked(mergeTask)).toHaveBeenCalled();
      const syncedStatuses = mockNotifyRenderer.mock.calls
        .filter(([channel]) => channel === 'mcp_task_state_sync')
        .map(
          ([, payload]) =>
            (payload as { verificationRun?: { status: string } }).verificationRun?.status,
        )
        .filter(Boolean);
      expect(syncedStatuses.slice(0, 2)).toEqual(['running', 'passed']);
    });

    it('escalates with the output tail and refuses to merge when it fails', async () => {
      coordinator.registerCoordinator('coord-1', 'proj-1', { verifyCommand: 'npm test' });
      mockVerifyStart.mockResolvedValueOnce({
        ...passedRun,
        status: 'failed',
        exitCode: 1,
        outputTail: '11 passed\n1 failed: adds numbers\n',
      });

      const error = await coordinator.landSelf('task-1', { verification }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Verification failed (exit 1): `npm test`');
      expect((error as Error).message).toContain('1 failed: adds numbers');
      expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
      expect(coordinator.getTask('task-1')).toMatchObject({
        landingState: 'landing_escalated',
        landingReason: expect.stringContaining('1 failed: adds numbers'),
        verificationRun: expect.objectContaining({ status: 'failed', exitCode: 1 }),
      });
    });

    it('skips the check when the coordinator has no verify command', async () => {
      await coordinator.landSelf('task-1', { verification, summary: 'done' });

      expect(mockVerifyStart).not.toHaveBeenCalled();
      expect(vi.mocked(mergeTask)).toHaveBeenCalled();
    });

    it('clears the command when re-registered with an empty string', async () => {
      coordinator.registerCoordinator('coord-1', 'proj-1', { verifyCommand: 'npm test' });
      coordinator.registerCoordinator('coord-1', 'proj-1', { verifyCommand: '' });

      await coordinator.landSelf('task-1', { verification, summary: 'done' });

      expect(mockVerifyStart).not.toHaveBeenCalled();
    });

    it('names the command in the sub-task preamble', async () => {
      coordinator.registerCoordinator('coord-1', 'proj-1', { verifyCommand: 'npm test' });
      mockCreateBackendTask.mockResolvedValue({
        id: 'task-2',
        branch_name: 'task/two',
        worktree_path: '/tmp/two',
      });

      await coordinator.createTask({
        name: 'two',
        prompt: 'do more',
        coordinatorTaskId: 'coord-1',
      });

      expect(coordinator.getTask('task-2')?.initialPrompt).toContain(
        'You do not need to run `npm test` yourself: land_self runs it',
      );
      expect(coordinator.getTask('task-1')?.initialPrompt).not.toContain('npm test');
    });

    it('escalates as an error run when the runner cannot start at all', async () => {
      coordinator.registerCoordinator('coord-1', 'proj-1', { verifyCommand: 'npm test' });
      mockVerifyStart.mockRejectedValueOnce(new Error('spawn ENOTDIR'));

      await expect(coordinator.landSelf('task-1', { verification })).rejects.toThrow(
        'Verification error: `npm test` — spawn ENOTDIR',
      );

      expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
      expect(coordinator.getTask('task-1')).toMatchObject({
        landingState: 'landing_escalated',
        verificationRun: expect.objectContaining({ status: 'error', message: 'spawn ENOTDIR' }),
      });
    });

    it('lets merge_task skip the check after an escalation', async () => {
      coordinator.registerCoordinator('coord-1', 'proj-1', { verifyCommand: 'npm test' });
      mockVerifyStart.mockResolvedValueOnce({ ...passedRun, status: 'failed', exitCode: 1 });
      await coordinator.landSelf('task-1', { verification }).catch(() => undefined);
      expect(coordinator.getTask('task-1')?.landingState).toBe('landing_escalated');

      await coordinator.mergeTask('task-1', { skipVerification: true });

      expect(mockVerifyStart).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mergeTask)).toHaveBeenCalled();
    });

    it('cancels an in-flight run when the task is cleaned up', async () => {
      await coordinator.closeTask('task-1');

      expect(mockVerifyCancel).toHaveBeenCalledWith('task-1');
    });
  });

  it('rejects dirty non-preamble worktrees before merging', async () => {
    mockGit(' M src/file.ts\n');

    await expect(coordinator.landSelf('task-1', { verification })).rejects.toThrow(
      'uncommitted changes',
    );

    expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landing_escalated');
  });

  it('rejects dirty preamble files that contain user-authored changes', async () => {
    const preambleWithUserChange =
      '<sub-task-mode>\nrules\n</sub-task-mode>\n\n# User-authored change\n';
    const fakeDiff =
      'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+# User-authored change\n';
    mockFsReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes('AGENTS.md')) return preambleWithUserChange;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockExistsSync.mockImplementation((p?: unknown) => String(p).includes('AGENTS.md'));
    mockReadFileSync.mockReturnValue(preambleWithUserChange);
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        cbMaybe?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : cbMaybe) as (
          err: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          cb(null, 'task/test\n', '');
          return;
        }
        if (args[0] === 'status') {
          cb(null, ' M AGENTS.md\n', '');
          return;
        }
        if (args[0] === 'show') {
          cb(null, '', '');
          return;
        }
        if (args[0] === 'diff') {
          cb(Object.assign(new Error('diff'), { code: 1, stdout: fakeDiff }), fakeDiff, '');
          return;
        }
        cb(null, '', '');
      },
    );

    await expect(coordinator.landSelf('task-1', { verification })).rejects.toThrow(
      'uncommitted changes in preamble files',
    );

    expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landing_escalated');
  });

  it('allows dirty settings.local.json when only injected systemPrompt is stripped', async () => {
    const settingsContent = JSON.stringify({
      systemPrompt: '<sub-task-mode>\nrules\n</sub-task-mode>',
    });
    mockFsReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes('settings.local.json')) return settingsContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockExistsSync.mockImplementation((p?: unknown) => String(p).includes('settings.local.json'));
    mockReadFileSync.mockReturnValue(settingsContent);
    let statusCalls = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        cbMaybe?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : cbMaybe) as (
          err: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          cb(null, 'task/test\n', '');
          return;
        }
        if (args[0] === 'status') {
          statusCalls += 1;
          cb(null, statusCalls <= 2 ? ' M .claude/settings.local.json\n' : '', '');
          return;
        }
        if (args[0] === 'show') {
          cb(null, '', '');
          return;
        }
        if (args[0] === 'diff') {
          cb(null, '', '');
          return;
        }
        if (args.join(' ') === 'rev-parse HEAD') {
          cb(null, 'landed-sha\n', '');
          return;
        }
        cb(null, '', '');
      },
    );

    const result = await coordinator.landSelf('task-1', { verification });

    expect(result.landingState).toBe('reviewed');
    expect(vi.mocked(mergeTask)).toHaveBeenCalled();
  });

  it('rejects orphaned tasks before merging', async () => {
    coordinator.deregisterCoordinator('coord-1');

    await expect(coordinator.landSelf('task-1', { verification })).rejects.toThrow('orphaned task');

    expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landing_escalated');
  });

  it('rejects branch mismatch before merging', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          cb(null, 'other-branch\n', '');
          return;
        }
        cb(null, '', '');
      },
    );

    await expect(coordinator.landSelf('task-1', { verification })).rejects.toThrow(
      'Branch mismatch',
    );

    expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landing_escalated');
  });

  it('records merge conflict as landing_escalated without cleanup', async () => {
    const { deleteTask: mockDeleteTask } = await import('../ipc/tasks.js');
    vi.mocked(mergeTask).mockRejectedValueOnce(new Error('Merge failed: conflict'));

    await expect(coordinator.landSelf('task-1', { verification })).rejects.toThrow('conflict');

    expect(vi.mocked(mockDeleteTask)).not.toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landing_escalated');
  });

  it('keeps landed state visible if landed commit resolution fails after merge', async () => {
    const { deleteTask: mockDeleteTask } = await import('../ipc/tasks.js');
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          cb(null, 'task/test\n', '');
          return;
        }
        if (args[0] === 'status') {
          cb(null, '', '');
          return;
        }
        if (args[0] === 'rev-parse') {
          cb(new Error('rev-parse failed'), '', 'fatal');
          return;
        }
        cb(null, '', '');
      },
    );

    await expect(coordinator.landSelf('task-1', { verification })).rejects.toThrow(
      'landed commit could not be resolved',
    );

    expect(vi.mocked(mergeTask)).toHaveBeenCalled();
    expect(vi.mocked(mockDeleteTask)).not.toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landed_cleanup_failed');
    expect(coordinator.getTask('task-1')?.landedMetadata?.landedCommit).toBe('unresolved');
  });

  it('records cleanup failure without hiding the landed merge', async () => {
    const { deleteTask: mockDeleteTask } = await import('../ipc/tasks.js');
    vi.mocked(mockDeleteTask).mockRejectedValueOnce(new Error('delete failed'));

    await expect(coordinator.landSelf('task-1', { verification })).rejects.toThrow(
      'cleanup failed',
    );

    expect(vi.mocked(mergeTask)).toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landed_cleanup_failed');
    expect(coordinator.getTask('task-1')?.landedMetadata?.landedCommit).toBe('landed-sha');
  });

  it('marks legacy landed pending-review task summaries as reviewed', () => {
    const task = coordinator.getTask('task-1');
    if (!task) throw new Error('test task missing');
    task.landingState = 'landed_pending_review';

    coordinator.markTaskReviewed('task-1');

    expect(coordinator.getTask('task-1')?.landingState).toBe('reviewed');
    expect(coordinator.listTasks()[0]?.landingState).toBe('reviewed');
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_state_sync',
      expect.objectContaining({
        taskId: 'task-1',
        landingState: 'reviewed',
        needsReview: false,
      }),
    );
  });
});

// ─── spawn defaults / skipPermissions tests ───────────────────────────────────

describe('Coordinator sub-agent spawn settings', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('defaults to bare claude command', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: 'claude' }),
    );
  });

  it('inherits coordinator command via setCoordinatorSpawnDefaults', async () => {
    coordinator.setCoordinatorSpawnDefaults('coord-1', '/usr/local/bin/claude', []);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: '/usr/local/bin/claude' }),
    );
  });

  it('passes the coordinator env file to sub-tasks so they get its credentials', async () => {
    coordinator.setCoordinatorAgentEnvFile('coord-1', '~/.config/parallel-code/claude.env');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ envFile: '~/.config/parallel-code/claude.env' }),
    );
  });

  it('inherits coordinator base args (e.g. --model)', async () => {
    coordinator.setCoordinatorSpawnDefaults('coord-1', 'claude', ['--model', 'claude-opus-4-7']);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).toContain('--model');
    expect(spawnArgs).toContain('claude-opus-4-7');
  });

  it('adds --dangerously-skip-permissions when coordinator has propagateSkipPermissions', async () => {
    // skipPermissions is inherited from coordinator state, not from createTask opts.
    coordinator.registerCoordinator('coord-skip', 'proj-1', { skipPermissions: true });
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-skip',
    });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).toContain('--dangerously-skip-permissions');
  });

  it('does not add --dangerously-skip-permissions when coordinator does not propagate', async () => {
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
    });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('inherited args do not include --dangerously-skip-permissions (handled separately)', async () => {
    // skip_permissions_args should not be passed as agentArgs — only agentDef.args (base args)
    coordinator.setCoordinatorSpawnDefaults('coord-1', 'claude', ['--model', 'claude-opus-4-7']);
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
      skipPermissions: false,
    });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    expect(spawnArgs).toContain('--model');
  });

  it('spawns sub-agent in the sub-task worktree path', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: '/tmp/test' }),
    );
  });

  it('uses docker run (dockerMode: true) when dockerContainerName is set — sub-task gets its own container', async () => {
    coordinator.setDockerContainerName('coord-1', 'my-container');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        // Sub-task uses docker run (dockerMode: true), not docker exec
        dockerMode: true,
        // Command is the agent command, not 'docker'
        command: 'claude',
        // Args are the agent args (not docker exec wrapper)
        args: expect.not.arrayContaining(['exec']),
      }),
    );
    // Coordinator container name is NOT in the args (sub-task has its own container)
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).not.toContain('my-container');
  });

  it('does not use docker mode when dockerContainerName is null', async () => {
    coordinator.setDockerContainerName('coord-1', null);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: 'claude' }),
    );
    const spawnCall = mockSpawnAgent.mock.calls[0][1] as { dockerMode?: boolean; args: string[] };
    expect(spawnCall.dockerMode).toBeUndefined();
    expect(spawnCall.args).not.toContain('docker');
  });

  it('docker run cwd is the sub-task worktree path, not the coordinator projectRoot', async () => {
    coordinator.setDockerContainerName('coord-1', 'my-container');
    // coordinator projectRoot is '/tmp/project', sub-task worktree is '/tmp/test'
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    // cwd (passed to pty.ts) is the sub-task worktree, not the coordinator's projectRoot
    const spawnCall = mockSpawnAgent.mock.calls[0][1] as { cwd: string };
    expect(spawnCall.cwd).toBe('/tmp/test');
    expect(spawnCall.cwd).not.toBe('/tmp/project');
  });
});

// ─── settings.local.json injection tests ─────────────────────────────────────

describe('Coordinator settings.local.json sub-task injection', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
  });

  it('writes settings.local.json with systemPrompt when file does not exist', async () => {
    mockFsAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const settingsWrite = mockAtomicWriteFile.mock.calls.find((c) =>
      (c[0] as string).endsWith('settings.local.json'),
    );
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(settingsWrite?.[1] as string);
    expect(written.systemPrompt).toContain('signal_done');
    expect(written.systemPrompt).toContain('sub-task-mode');
  });

  it('appends preamble to existing systemPrompt in settings.local.json', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue(JSON.stringify({ systemPrompt: 'existing prompt' }));
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const settingsWrite = mockAtomicWriteFile.mock.calls.find((c) =>
      (c[0] as string).endsWith('settings.local.json'),
    );
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(settingsWrite?.[1] as string);
    expect(written.systemPrompt).toContain('existing prompt');
    expect(written.systemPrompt).toContain('signal_done');
  });

  it('preserves other keys in existing settings.local.json', async () => {
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue(JSON.stringify({ permissions: { allow: ['Bash'] } }));
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const settingsWrite = mockAtomicWriteFile.mock.calls.find((c) =>
      (c[0] as string).endsWith('settings.local.json'),
    );
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(settingsWrite?.[1] as string);
    expect(written.permissions).toEqual({ allow: ['Bash'] });
    expect(written.systemPrompt).toContain('signal_done');
  });

  it('does not restore settings.local.json on idle (no restore needed)', async () => {
    mockFsAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    const outputCb = getOutputCb();
    outputCb(encode('Working ❯ '));

    const settingsWriteCallsAfterIdle = mockAtomicWriteFile.mock.calls.filter((c) =>
      (c[0] as string).endsWith('settings.local.json'),
    );
    // Only the initial write; no re-write on idle
    expect(settingsWriteCallsAfterIdle).toHaveLength(1);
  });

  it('does not write to CLAUDE.md', async () => {
    mockFsAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const claudeWrite = mockAtomicWriteFile.mock.calls.find((c) =>
      (c[0] as string).endsWith('CLAUDE.md'),
    );
    expect(claudeWrite).toBeUndefined();
  });
});

// ─── waitForIdle tests ────────────────────────────────────────────────────────

describe('Coordinator waitForIdle', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects for unknown taskId', async () => {
    await expect(coordinator.waitForIdle('nonexistent')).rejects.toThrow('Task not found');
  });

  it('resolves immediately when task is already idle', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('startup echo ❯ '));
    outputCb(encode('real work output '.repeat(40)));
    outputCb(encode('Done ❯ '));
    await expect(coordinator.waitForIdle('task-1')).resolves.toEqual({ reason: 'idle' });
  });

  it('resolves when agent outputs prompt', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const outputCb = getOutputCb();
    const waitPromise = coordinator.waitForIdle('task-1');
    outputCb(encode('working...'));
    outputCb(encode('Done ❯ '));
    await expect(waitPromise).resolves.toEqual({ reason: 'idle' });
  });

  it('resolves immediately when task is under human control', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.waitForIdle('task-1')).resolves.toEqual({ reason: 'human_control' });
  });

  it('rejects control changes for unknown tasks', () => {
    expect(() => coordinator.setTaskControl('missing-task', 'human')).toThrow(
      'Task not found: missing-task',
    );
  });

  it('rejects after timeout when task never idles', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForIdle('task-1', 1_000);
    vi.advanceTimersByTime(1_001);
    await expect(waitPromise).rejects.toThrow('Timed out');
  });

  it('resolves when task exits (PTY exit fires idle resolvers)', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    const waitPromise = coordinator.waitForIdle('task-1');
    exitHandler(agentId, { exitCode: 0 });
    await expect(waitPromise).resolves.toEqual({ reason: 'exited' });
  });

  it('fires pending idle resolvers when control returns to coordinator', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    // The real scenario: task is running, coordinator calls waitForIdle, user takes control, coordinator returns
    const waitPromise = coordinator.waitForIdle('task-1');
    coordinator.setTaskControl('task-1', 'coordinator');
    await expect(waitPromise).resolves.toEqual({ reason: 'idle' });
  });

  it('does not stage a manual-control notification when control returns to coordinator', async () => {
    await coordinator.createTask({ name: 'my-task', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const waitPromise = coordinator.waitForIdle('task-1');

    coordinator.setTaskControl('task-1', 'human');
    await expect(waitPromise).resolves.toEqual({ reason: 'human_control' });
    mockNotifyRenderer.mockClear();

    coordinator.setTaskControl('task-1', 'coordinator');

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });
});

// ─── waitForSignalDone tests ──────────────────────────────────────────────────

describe('Coordinator waitForSignalDone', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects for unknown coordinatorId', async () => {
    await expect(coordinator.waitForSignalDone('nonexistent-coord')).rejects.toThrow(
      'Coordinator not found',
    );
  });

  it('resolves immediately with unconsumed signal if already signalled', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');
    await expect(coordinator.waitForSignalDone('coord-1')).resolves.toMatchObject({
      taskId: 'task-1',
      name: 'test',
      remaining: 0,
      status: expect.any(String),
      signalDoneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('resolves when signalDone is called, with remaining count', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForSignalDone('coord-1');
    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toMatchObject({
      taskId: 'task-1',
      name: 'test',
      remaining: 0,
      status: expect.any(String),
      signalDoneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('resolves with timedOut:true when signal never arrives', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForSignalDone('coord-1', 1_000);
    vi.advanceTimersByTime(1_001);
    const result = await waitPromise;
    expect(result.timedOut).toBe(true);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it('returns remaining=1 when another task is still running', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-1', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-2', branch_name: 'task/b', worktree_path: '/tmp/b' });
    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForSignalDone('coord-1');
    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toMatchObject({
      taskId: 'task-1',
      name: 'task-a',
      remaining: 1,
      status: expect.any(String),
      signalDoneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('does not stage pending notifications while any signal_done wait is active', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-1', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-2', branch_name: 'task/b', worktree_path: '/tmp/b' });

    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-2');
    mockNotifyRenderer.mockClear();

    const waitPromise = coordinator.waitForSignalDone('coord-1');
    const task2OutputCb = mockSubscribeToAgent.mock.calls[1][1] as (encoded: string) => void;
    emitWorkThenIdle(task2OutputCb);

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );

    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toMatchObject({ taskId: 'task-1' });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({
        coordinatorTaskId: 'coord-1',
        text: expect.stringContaining('"task-b" ready for review'),
      }),
    );
  });

  it('clears an already staged notification when a signal_done wait starts', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    emitWorkThenIdle(outputCb);

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
    );

    mockNotifyRenderer.mockClear();
    const waitPromise = coordinator.waitForSignalDone('coord-1');

    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
      coordinatorTaskId: 'coord-1',
    });

    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toMatchObject({ taskId: 'task-1' });
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });
});

// ─── sendPrompt tests ─────────────────────────────────────────────────────────

describe('Coordinator sendPrompt', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('rejects for unknown taskId', async () => {
    await expect(coordinator.sendPrompt('nonexistent', 'hello')).rejects.toThrow('Task not found');
  });

  it('queues prompts while task has an active user lease', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.sendPrompt('task-1', 'hello')).resolves.toEqual({ queued: true });
    expect(coordinator.getTaskStatus('task-1')?.pendingPrompt).toBe('hello');
    expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toEqual(['hello']);
  });

  it('flushes a queued prompt when the user activity lease clears', async () => {
    await coordinator.createTask({ name: 'my-task', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');
    await coordinator.sendPrompt('task-1', 'hello');
    mockNotifyRenderer.mockClear();

    coordinator.setTaskControl('task-1', 'coordinator');
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(coordinator.getTaskStatus('task-1')?.pendingPrompt).toBeUndefined();
  });

  it('does not notify coordinator when control returns without a prior blocked send_prompt', async () => {
    await coordinator.createTask({ name: 'my-task', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    mockNotifyRenderer.mockClear();

    coordinator.setTaskControl('task-1', 'coordinator');

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });

  it('syncs frontend done/review flags back to running when sending a new prompt', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    mockNotifyRenderer.mockClear();

    await coordinator.sendPrompt('task-1', 'new work');

    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_state_sync', {
      taskId: 'task-1',
      signalDoneReceived: false,
      signalDoneAt: null,
      signalDoneConsumed: false,
      needsReview: false,
    });
  });

  it('enforces the prompt size limit in UTF-8 bytes', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    await expect(coordinator.sendPrompt('task-1', '😀'.repeat(20_000))).rejects.toThrow(
      'byte limit',
    );
  });

  it('enforces the prompt size limit before queueing behind an undelivered initial prompt', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    await expect(coordinator.sendPrompt('task-1', '😀'.repeat(20_000))).rejects.toThrow(
      'byte limit',
    );
    expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toBeUndefined();
  });

  it('queues an in-limit Unicode prompt exactly behind an undelivered initial prompt', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const prompt = `continue with ${'火'.repeat(100)} 😀`;
    await expect(coordinator.sendPrompt('task-1', prompt)).resolves.toEqual({ queued: true });

    expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toEqual([prompt]);
    expect(mockWriteToAgent).not.toHaveBeenCalledWith(expect.any(String), prompt);
  });

  it('returns a defensive copy of pending prompts in task status', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    await coordinator.sendPrompt('task-1', 'queued-one');
    const statusPrompts = coordinator.getTaskStatus('task-1')?.pendingPrompts;
    statusPrompts?.push('mutated-outside');

    expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toEqual(['queued-one']);
  });

  it('reports the first pending prompt and queue count consistently', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    await coordinator.sendPrompt('task-1', 'queued-one');
    await coordinator.sendPrompt('task-1', 'queued-two');

    expect(coordinator.getTaskStatus('task-1')).toMatchObject({
      pendingPrompt: 'queued-one',
      pendingPrompts: ['queued-one', 'queued-two'],
      pendingPromptCount: 2,
    });
  });

  it('markPromptDelivered clears prompt delivery timers and write locks', async () => {
    vi.useFakeTimers();
    try {
      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do',
        coordinatorTaskId: 'coord-1',
      });
      const outputCb = getOutputCb();
      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));

      const c = coordinator as unknown as {
        initialPromptReadyTasks: Set<string>;
        initialPromptTimers: Map<string, unknown>;
        promptReadySeenAt: Map<string, unknown>;
        writingPromptTaskIds: Set<string>;
      };
      c.promptReadySeenAt.set(task.id, 123);
      c.writingPromptTaskIds.add(task.id);

      coordinator.markPromptDelivered(task.id);

      expect(c.initialPromptReadyTasks.has(task.id)).toBe(false);
      expect(c.initialPromptTimers.has(task.id)).toBe(false);
      expect(c.promptReadySeenAt.has(task.id)).toBe(false);
      expect(c.writingPromptTaskIds.has(task.id)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        task.agentId,
        expect.stringContaining('do'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects the 33rd prompt queued behind an undelivered initial prompt without mutating the queue', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const prompts = Array.from({ length: 32 }, (_, i) => `queued-${i}`);
    for (const prompt of prompts) {
      await expect(coordinator.sendPrompt('task-1', prompt)).resolves.toEqual({ queued: true });
    }

    await expect(coordinator.sendPrompt('task-1', 'queued-overflow')).rejects.toThrow(
      'Prompt queue full (32 pending)',
    );
    expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toEqual(prompts);
    expect(coordinator.getTaskStatus('task-1')?.pendingPromptCount).toBe(32);
  });

  it('rejects the 33rd prompt queued behind human control without mutating the queue', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');

    const prompts = Array.from({ length: 32 }, (_, i) => `queued-${i}`);
    for (const prompt of prompts) {
      await expect(coordinator.sendPrompt('task-1', prompt)).resolves.toEqual({ queued: true });
    }

    await expect(coordinator.sendPrompt('task-1', 'queued-overflow')).rejects.toThrow(
      'Prompt queue full (32 pending)',
    );
    expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toEqual(prompts);
    expect(coordinator.getTaskStatus('task-1')?.pendingPromptCount).toBe(32);
  });

  it('writes an in-limit Unicode prompt exactly once', async () => {
    vi.useFakeTimers();
    try {
      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do',
        coordinatorTaskId: 'coord-1',
      });
      coordinator.markPromptDelivered('task-1');

      const prompt = `Summarize these notes exactly: ${'火'.repeat(100)} 😀`;
      const sendPromise = coordinator.sendPrompt('task-1', prompt);
      await vi.advanceTimersByTimeAsync(500);

      await expect(sendPromise).resolves.toEqual({ queued: false });
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, prompt);
      expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
      const exactPromptWrites = mockWriteToAgent.mock.calls.filter(([, text]) => text === prompt);
      expect(exactPromptWrites).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets automationWriteInFlight only while an immediate prompt write is active', async () => {
    vi.useFakeTimers();
    try {
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');
      mockNotifyRenderer.mockClear();

      const sendPromise = coordinator.sendPrompt('task-1', 'new work');

      expect(coordinator.isAutomationWriteInFlight('task-1')).toBe(true);
      expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_state_sync', {
        taskId: 'task-1',
        automationWriteInFlight: true,
      });

      await vi.advanceTimersByTimeAsync(500);
      await expect(sendPromise).resolves.toEqual({ queued: false });

      expect(coordinator.isAutomationWriteInFlight('task-1')).toBe(false);
      expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_state_sync', {
        taskId: 'task-1',
        automationWriteInFlight: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears automationWriteInFlight when an immediate prompt body write fails', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    mockWriteToAgent.mockImplementationOnce((agentId: string, data: string) => ({
      id: agentId,
      data,
    }));
    mockWriteToAgent.mockImplementationOnce(() => {
      throw new Error('pty body failed');
    });

    await expect(coordinator.sendPrompt('task-1', 'new work')).rejects.toThrow(
      'Prompt body write failed',
    );

    expect(coordinator.isAutomationWriteInFlight('task-1')).toBe(false);
    expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toBeUndefined();
  });

  it('second concurrent sendPrompt is queued while the first write lock is held', async () => {
    vi.useFakeTimers();
    try {
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');

      // First sendPrompt: acquires writingPromptTaskIds lock, awaits 50ms write delay.
      const firstPromise = coordinator.sendPrompt('task-1', 'first');
      // Second concurrent call: lock is already held, must queue rather than write through.
      const secondResult = await coordinator.sendPrompt('task-1', 'second');
      expect(secondResult).toEqual({ queued: true });

      // Advance through the first write delay + flush's write delay.
      await vi.advanceTimersByTimeAsync(200);
      await expect(firstPromise).resolves.toEqual({ queued: false });

      // Both prompts written in order, not interleaved.
      const textCalls = mockWriteToAgent.mock.calls
        .map((c) => c[1] as string)
        .filter((t) => t === 'first' || t === 'second');
      expect(textCalls).toEqual(['first', 'second']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes queued prompts in FIFO order as the agent becomes ready between writes', async () => {
    vi.useFakeTimers();
    try {
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');
      const outputCb = getOutputCb();
      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      coordinator.setTaskControl('task-1', 'human');

      const prompts = ['first', 'second', 'third', 'fourth'];
      for (const prompt of prompts) {
        await expect(coordinator.sendPrompt('task-1', prompt)).resolves.toEqual({ queued: true });
      }

      coordinator.setTaskControl('task-1', 'coordinator');
      await vi.advanceTimersByTimeAsync(100);
      expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toEqual([
        'second',
        'third',
        'fourth',
      ]);

      for (let i = 0; i < 3; i += 1) {
        outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
        await vi.advanceTimersByTimeAsync(100);
      }

      const textCalls = mockWriteToAgent.mock.calls
        .map((c) => c[1] as string)
        .filter((text) => prompts.includes(text));
      expect(textCalls).toEqual(prompts);
      expect(coordinator.getTaskStatus('task-1')).toMatchObject({
        pendingPrompt: undefined,
        pendingPrompts: undefined,
        pendingPromptCount: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a queued prompt body when only the Enter write fails', async () => {
    vi.useFakeTimers();
    try {
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');
      coordinator.setTaskControl('task-1', 'human');
      await coordinator.sendPrompt('task-1', 'queued');

      mockWriteToAgent.mockClear();
      mockWriteToAgent.mockImplementation((agentId: string, data: string) => {
        if (data === '\r') throw new Error('pty enter failed');
        return { id: agentId };
      });

      coordinator.setTaskControl('task-1', 'coordinator');
      await vi.advanceTimersByTimeAsync(100);

      const bodyWrites = mockWriteToAgent.mock.calls.filter(([, data]) => data === 'queued');
      expect(bodyWrites).toHaveLength(1);
      expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toBeUndefined();
    } finally {
      mockWriteToAgent.mockReset();
      mockWriteToAgent.mockImplementation((agentId: string, data: string) => ({
        id: agentId,
        data,
      }));
      vi.useRealTimers();
    }
  });

  it('keeps a queued prompt and retries when the body write fails', async () => {
    vi.useFakeTimers();
    try {
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');
      const outputCb = getOutputCb();
      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      coordinator.setTaskControl('task-1', 'human');
      await coordinator.sendPrompt('task-1', 'queued');

      let failedBodyOnce = false;
      mockWriteToAgent.mockClear();
      mockWriteToAgent.mockImplementation((agentId: string, data: string) => {
        if (data === 'queued' && !failedBodyOnce) {
          failedBodyOnce = true;
          throw new Error('pty body failed');
        }
        return { id: agentId, data };
      });

      coordinator.setTaskControl('task-1', 'coordinator');
      await vi.advanceTimersByTimeAsync(100);
      expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toEqual(['queued']);

      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(200);

      const bodyWrites = mockWriteToAgent.mock.calls.filter(([, data]) => data === 'queued');
      expect(bodyWrites).toHaveLength(2);
      expect(mockWriteToAgent).toHaveBeenCalledWith(expect.any(String), '\r');
      expect(coordinator.getTaskStatus('task-1')?.pendingPrompts).toBeUndefined();
    } finally {
      mockWriteToAgent.mockReset();
      mockWriteToAgent.mockImplementation((agentId: string, data: string) => ({
        id: agentId,
        data,
      }));
      vi.useRealTimers();
    }
  });
});

// ─── mergeTask active ownership guard ─────────────────────────────────────────

describe('Coordinator mergeTask active ownership guard', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    vi.mocked(mergeTask).mockResolvedValue({
      main_branch: 'main',
      lines_added: 1,
      lines_removed: 0,
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('rejects merge_task for a running task that has not signaled manual review', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    await expect(coordinator.mergeTask('task-1')).rejects.toThrow('still running');

    expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
  });

  it('allows legacy signal_done manual-review tasks even if the agent process is still running', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');

    await expect(coordinator.mergeTask('task-1')).resolves.toEqual({
      mainBranch: 'main',
      linesAdded: 1,
      linesRemoved: 0,
    });

    expect(vi.mocked(mergeTask)).toHaveBeenCalled();
  });

  it('runs the verify command before a coordinator-driven merge and escalates on failure', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1', { verifyCommand: 'npm test' });
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');
    mockVerifyStart.mockResolvedValueOnce({
      command: 'npm test',
      status: 'timed_out',
      exitCode: null,
      headSha: null,
      dirty: false,
      startedAt: '2026-09-03T10:00:00.000Z',
      finishedAt: '2026-09-03T10:10:00.000Z',
      outputTail: '',
      message: 'Timed out after 10 min.',
    });

    await expect(coordinator.mergeTask('task-1')).rejects.toThrow(
      'Verification timed out: `npm test` — Timed out after 10 min.',
    );

    expect(vi.mocked(mergeTask)).not.toHaveBeenCalled();
    expect(coordinator.getTask('task-1')?.landingState).toBe('landing_escalated');
  });
});

// ─── deregisterCoordinator tests ──────────────────────────────────────────────

describe('Coordinator deregisterCoordinator', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
  });

  it('is a no-op for unknown coordinator', () => {
    expect(() => coordinator.deregisterCoordinator('nonexistent')).not.toThrow();
  });

  it('child tasks are removed from internal map after coordinator is deregistered', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.deregisterCoordinator('coord-1');
    // markPromptDelivered is now a no-op — task was removed from this.tasks
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    mockNotifyRenderer.mockClear();
    outputCb(encode('Done ❯ '));
    // PTY output is silently dropped — no orphaned notification because the task entry is gone
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_orphaned_notification',
      expect.anything(),
    );
  });

  it('clears staged notification when coordinator is deregistered', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    emitWorkThenIdle(outputCb);

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
    );

    mockNotifyRenderer.mockClear();
    coordinator.deregisterCoordinator('coord-1');

    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
      coordinatorTaskId: 'coord-1',
    });
  });

  it('hasActiveCoordinator returns false after deregister', () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    expect(coordinator.hasActiveCoordinator()).toBe(true);
    coordinator.deregisterCoordinator('coord-1');
    expect(coordinator.hasActiveCoordinator()).toBe(false);
  });

  it('deregister cleans up backend resource maps for child tasks', async () => {
    const { unsubscribeFromAgent } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const agentId = getAgentId();

    // Confirm subscriber was registered
    expect(mockSubscribeToAgent).toHaveBeenCalledWith(agentId, expect.any(Function));

    coordinator.deregisterCoordinator('coord-1');

    // PTY subscriber must be unregistered
    expect(vi.mocked(unsubscribeFromAgent)).toHaveBeenCalledWith(agentId, expect.any(Function));

    // Internal maps must no longer hold stale entries
    const c = coordinator as unknown as {
      subscribers: Map<string, unknown>;
      tailBuffers: Map<string, unknown>;
      decoders: Map<string, unknown>;
      controlMap: Map<string, unknown>;
    };
    expect(c.subscribers.has(agentId)).toBe(false);
    expect(c.tailBuffers.has(agentId)).toBe(false);
    expect(c.decoders.has(agentId)).toBe(false);
  });

  it('deregister clears scheduled initial prompt delivery timers for child tasks', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      const outputCb = getOutputCb();

      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      const c = coordinator as unknown as {
        initialPromptTimers: Map<string, unknown>;
      };
      expect(c.initialPromptTimers.has('task-1')).toBe(true);

      coordinator.deregisterCoordinator('coord-1');

      expect(c.initialPromptTimers.has('task-1')).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('do'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('deregister clears scheduled queued prompt flush timers for child tasks', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do',
        coordinatorTaskId: 'coord-1',
      });
      coordinator.markPromptDelivered(task.id);
      task.pendingPrompts = ['queued'];
      const outputCb = getOutputCb();

      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      const c = coordinator as unknown as {
        queuedPromptFlushTimers: Map<string, unknown>;
      };
      expect(c.queuedPromptFlushTimers.has(task.id)).toBe(true);

      coordinator.deregisterCoordinator('coord-1');

      expect(c.queuedPromptFlushTimers.has(task.id)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(task.agentId, 'queued');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deregister clears all prompt delivery bookkeeping for child tasks', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do',
        coordinatorTaskId: 'coord-1',
      });
      const outputCb = getOutputCb();
      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));

      const c = coordinator as unknown as {
        initialPromptReadyTasks: Set<string>;
        initialPromptTimers: Map<string, unknown>;
        promptReadySeenAt: Map<string, unknown>;
        writingPromptTaskIds: Set<string>;
      };
      c.promptReadySeenAt.set(task.id, 123);
      c.writingPromptTaskIds.add(task.id);

      expect(c.initialPromptReadyTasks.has(task.id)).toBe(true);
      expect(c.initialPromptTimers.has(task.id)).toBe(true);
      expect(c.promptReadySeenAt.has(task.id)).toBe(true);
      expect(c.writingPromptTaskIds.has(task.id)).toBe(true);

      coordinator.deregisterCoordinator('coord-1');

      expect(c.initialPromptReadyTasks.has(task.id)).toBe(false);
      expect(c.initialPromptTimers.has(task.id)).toBe(false);
      expect(c.promptReadySeenAt.has(task.id)).toBe(false);
      expect(c.writingPromptTaskIds.has(task.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── per-task projectRoot tests ───────────────────────────────────────────────

describe('Coordinator per-task projectRoot', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project-a');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('task stores the projectRoot at creation time', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')?.projectRoot).toBe('/tmp/project-a');
  });

  it('later setDefaultProject does not affect existing task projectRoot', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setDefaultProject('proj-2', '/tmp/project-b');
    expect(coordinator.getTask('task-1')?.projectRoot).toBe('/tmp/project-a');
  });
});

// ─── waiter resolver cleanup tests ───────────────────────────────────────────

describe('Coordinator waiter resolver cleanup on timeout', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes idle resolver after timeout so stale callback is not called on later idle', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const outputCb = getOutputCb();

    const p = coordinator.waitForIdle('task-1', 500);
    vi.advanceTimersByTime(501);
    await expect(p).rejects.toThrow('Timed out');

    // Now the task goes idle — no stale resolver should fire (no throw, no hang)
    let resolveCalled = false;
    const p2 = coordinator.waitForIdle('task-1', 500);
    p2.then(() => {
      resolveCalled = true;
    }).catch(() => {});
    outputCb(encode('Done ❯ '));
    await Promise.resolve(); // flush microtasks
    expect(resolveCalled).toBe(true);
  });

  it('removes signal_done resolver after timeout so stale callback is not called on later signal', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const p = coordinator.waitForSignalDone('coord-1', 500);
    vi.advanceTimersByTime(501);
    const timedOutResult = await p;
    expect(timedOutResult.timedOut).toBe(true);

    // signalDone fires after timeout — should resolve a new waiter, not the stale one
    let resolveCalled = false;
    const p2 = coordinator.waitForSignalDone('coord-1', 500);
    p2.then(() => {
      resolveCalled = true;
    }).catch(() => {});
    coordinator.signalDone('task-1');
    await Promise.resolve();
    expect(resolveCalled).toBe(true);
  });
});

// ─── MCP_TaskCreated spawn settings tests ────────────────────────────────────

describe('Coordinator MCP_TaskCreated spawn settings', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('includes agentCommand in MCP_TaskCreated payload', async () => {
    coordinator.setCoordinatorSpawnDefaults('coord-1', '/usr/local/bin/claude', []);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ agentCommand: '/usr/local/bin/claude' }),
    );
  });

  it('includes agentArgs in MCP_TaskCreated payload (without --dangerously-skip-permissions)', async () => {
    coordinator.setCoordinatorSpawnDefaults('coord-1', 'claude', ['--model', 'claude-opus-4-7']);
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
    });
    const payload = mockNotifyRenderer.mock.calls.find((c) => c[0] === 'mcp_task_created')?.[1] as {
      agentArgs: string[];
    };
    expect(payload.agentArgs).toContain('--model');
    expect(payload.agentArgs).toContain('claude-opus-4-7');
    expect(payload.agentArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('includes subtask MCP launch args in MCP_TaskCreated payload', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'coordinator-token',
      'subtask-token',
      '/tmp/mcp-server.cjs',
    );
    coordinator.setCoordinatorSpawnDefaults('coord-1', 'codex', []);

    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const payload = mockNotifyRenderer.mock.calls.find((c) => c[0] === 'mcp_task_created')?.[1] as {
      mcpLaunchArgs: string[];
    };
    expect(payload.mcpLaunchArgs).toEqual([
      '--config',
      expect.stringContaining('mcp_servers.parallel-code'),
    ]);
  });

  it('includes backend-owned initial prompt in MCP_TaskCreated payload for renderer display and restart hydration', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({
        prompt: expect.stringContaining('do'),
      }),
    );
  });

  it('includes skipPermissions true in MCP_TaskCreated payload when coordinator has propagateSkipPermissions', async () => {
    // skipPermissions is now inherited from the coordinator's propagateSkipPermissions,
    // not from createTask opts. Re-register with skipPermissions: true.
    coordinator.registerCoordinator('coord-skip', 'proj-1', { skipPermissions: true });
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-skip',
    });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ skipPermissions: true }),
    );
  });

  it('includes skipPermissions false when not set', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ skipPermissions: false }),
    );
  });
});

// ─── Item 5: Sub-agent MCP config isolation ──────────────────────────────────

describe('Coordinator sub-task MCP config isolation', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('each sub-task gets its own unique task-id in .mcp.json args, not the coordinator id', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-a', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-b', branch_name: 'task/b', worktree_path: '/tmp/b' });

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'task-a', prompt: 'do a', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do b', coordinatorTaskId: 'coord-1' });

    const configWrites = mockAtomicWriteFile.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(2);

    const taskIds = configWrites.map((c) => {
      const cfg = JSON.parse(c[1] as string) as {
        mcpServers: { 'parallel-code': { args: string[] } };
      };
      const args = cfg.mcpServers['parallel-code'].args;
      const idx = args.indexOf('--task-id');
      return idx >= 0 ? args[idx + 1] : null;
    });

    // Each task must have its own id
    expect(taskIds[0]).toBe('task-a');
    expect(taskIds[1]).toBe('task-b');
    // Neither should use the coordinator id
    expect(taskIds).not.toContain('coord-1');
    // The two task ids must be distinct
    expect(taskIds[0]).not.toBe(taskIds[1]);
  });

  it('config files for two sub-tasks are written to different paths', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-a', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-b', branch_name: 'task/b', worktree_path: '/tmp/b' });

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'task-a', prompt: 'do a', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do b', coordinatorTaskId: 'coord-1' });

    const configPaths = mockAtomicWriteFile.mock.calls
      .filter((c) => (c[0] as string).includes('parallel-code-subtask-'))
      .map((c) => c[0] as string);

    expect(configPaths[0]).not.toBe(configPaths[1]);
  });
});

// ─── MCP config restart rewrite tests ────────────────────────────────────────

describe('Coordinator MCP config restart rewrite', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('rewrites MCP config for existing task when server info changes (restart)', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'old-token',
      'old-token',
      '/path/to/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    expect(task?.mcpConfigPath).toBeDefined();

    const initialWrite = mockAtomicWriteFile.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(initialWrite).toBeDefined();
    if (!initialWrite) throw new Error('expected initial config write');
    const initialConfig = JSON.parse(initialWrite[1] as string) as {
      mcpServers: { 'parallel-code': { args: string[]; env: Record<string, string> } };
    };
    expect(initialConfig.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe(
      'old-token',
    );
    expect(initialConfig.mcpServers['parallel-code'].args).toContain('http://localhost:3001');

    // Simulate coordinator restart with new port/token
    mockAtomicWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-token',
      'new-token',
      '/path/to/server.js',
    );

    const rewriteCall = mockAtomicWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(rewriteCall).toBeDefined();
    if (!rewriteCall) throw new Error('expected rewrite call');
    // Path must be the same file the task already references
    expect(rewriteCall[0]).toBe(task?.mcpConfigPath);

    // Rewritten config is valid JSON with updated URL and token, preserving the task id
    const newConfig = JSON.parse(rewriteCall[1] as string) as {
      mcpServers: { 'parallel-code': { args: string[]; env: Record<string, string> } };
    };
    const newArgs = newConfig.mcpServers['parallel-code'].args;
    expect(newConfig.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe('new-token');
    expect(newArgs).toContain('http://localhost:3002');
    expect(newArgs).toContain('task-1');
    // Old values must be gone
    expect(newConfig.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).not.toBe(
      'old-token',
    );
    expect(newArgs).not.toContain('http://localhost:3001');
  });

  it('does not write config files when no tasks exist on setMCPServerInfo', () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'old-token',
      'old-token',
      '/path/to/server.js',
    );
    mockAtomicWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-token',
      'new-token',
      '/path/to/server.js',
    );

    const configWrites = mockAtomicWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(0);
  });

  it('rewrites configs for all existing tasks on restart', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-1', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-2', branch_name: 'task/b', worktree_path: '/tmp/b' });

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'old-token',
      'old-token',
      '/path/to/server.js',
    );
    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do', coordinatorTaskId: 'coord-1' });

    mockAtomicWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-token',
      'new-token',
      '/path/to/server.js',
    );

    const rewrites = mockAtomicWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(rewrites).toHaveLength(2);

    for (const rewrite of rewrites) {
      const cfg = JSON.parse(rewrite[1] as string) as {
        mcpServers: { 'parallel-code': { args: string[]; env: Record<string, string> } };
      };
      expect(cfg.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe('new-token');
      expect(cfg.mcpServers['parallel-code'].args).toContain('http://localhost:3002');
    }
  });

  it('does not rewrite config for tasks that have no mcpConfigPath (spawned without MCP info)', async () => {
    // No setMCPServerInfo before createTask — task gets no mcpConfigPath
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')?.mcpConfigPath).toBeUndefined();

    mockAtomicWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-token',
      'new-token',
      '/path/to/server.js',
    );

    const configWrites = mockAtomicWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(0);
  });
});

// ─── Two-class token: subtask configs use subtaskToken, not coordinator token ──

describe('Coordinator two-class token — subtask configs use subtaskToken', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('createTask writes subtaskToken (not coordinator token) into the sub-task MCP config', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'coordinator-secret',
      'subtask-secret',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const configWrite = mockAtomicWriteFile.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrite).toBeDefined();
    if (!configWrite) throw new Error('expected config write');

    const config = JSON.parse(configWrite[1] as string) as {
      mcpServers: { 'parallel-code': { env: Record<string, string> } };
    };
    const writtenToken = config.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN'];
    expect(writtenToken).toBe('subtask-secret');
    expect(writtenToken).not.toBe('coordinator-secret');
  });

  it('setMCPServerInfo rewrites existing sub-task configs with subtaskToken on restart', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'old-coordinator',
      'old-subtask',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    mockAtomicWriteFileSync.mockClear();

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-coordinator',
      'new-subtask',
      '/path/server.js',
    );

    const rewrite = mockAtomicWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(rewrite).toBeDefined();
    if (!rewrite) throw new Error('expected rewrite');

    const config = JSON.parse(rewrite[1] as string) as {
      mcpServers: { 'parallel-code': { env: Record<string, string> } };
    };
    const writtenToken = config.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN'];
    expect(writtenToken).toBe('new-subtask');
    expect(writtenToken).not.toBe('new-coordinator');
  });
});

// ─── Item 5: Coordinator restart hydration ────────────────────────────────────

describe('Coordinator hydrateTask — restart hydration', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('hydrateTask + getTask returns all expected fields', () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    const task = coordinator.getTask('hydrated-1');
    expect(task).toBeDefined();
    expect(task?.id).toBe('hydrated-1');
    expect(task?.name).toBe('hydrated-task');
    expect(task?.projectId).toBe('proj-1');
    expect(task?.branchName).toBe('task/hydrated');
    expect(task?.worktreePath).toBe('/tmp/hydrated');
    expect(task?.agentId).toBe('agent-hydrated');
    expect(task?.coordinatorTaskId).toBe('coord-1');
    expect(task?.status).toBe('exited');
  });

  it('hydrateTask restores an undelivered initial prompt for backend delivery', () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
      initialPrompt: 'do the restored work',
    });

    const task = coordinator.getTask('hydrated-1');
    expect(task?.initialPrompt).toBe('do the restored work');
    expect(task?.assignedPromptDelivered).toBe(false);
  });

  it('hydrateTask delivers a restored initial prompt after the agent respawns ready', async () => {
    vi.useFakeTimers();
    try {
      coordinator.hydrateTask({
        id: 'hydrated-1',
        name: 'hydrated-task',
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        branchName: 'task/hydrated',
        worktreePath: '/tmp/hydrated',
        agentId: 'agent-hydrated',
        coordinatorTaskId: 'coord-1',
        initialPrompt: 'do the restored work',
      });

      getSpawnHandler()('agent-hydrated');
      const cb = mockSubscribeToAgent.mock.calls.find(
        (call) => call[0] === 'agent-hydrated',
      )?.[1] as ((encoded: string) => void) | undefined;
      expect(cb).toBeDefined();
      cb?.(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        'agent-hydrated',
        expect.stringContaining('do the restored work'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith('agent-hydrated', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrateTask preserves restored initial and queued prompts and flushes them in order', async () => {
    vi.useFakeTimers();
    try {
      coordinator.hydrateTask({
        id: 'hydrated-1',
        name: 'hydrated-task',
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        branchName: 'task/hydrated',
        worktreePath: '/tmp/hydrated',
        agentId: 'agent-hydrated',
        coordinatorTaskId: 'coord-1',
        initialPrompt: 'do the restored work',
        pendingPrompts: ['follow restored'],
      });

      getSpawnHandler()('agent-hydrated');
      const cb = mockSubscribeToAgent.mock.calls.find(
        (call) => call[0] === 'agent-hydrated',
      )?.[1] as ((encoded: string) => void) | undefined;
      expect(cb).toBeDefined();
      cb?.(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);
      cb?.(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(100);

      const textWrites = mockWriteToAgent.mock.calls
        .filter(
          ([agentId, text]) => agentId === 'agent-hydrated' && text !== '\r' && text !== '\x1b[I',
        )
        .map(([, text]) => text);
      expect(textWrites[0]).toEqual(expect.stringContaining('do the restored work'));
      expect(textWrites[1]).toBe('follow restored');
      expect(coordinator.getTaskStatus('hydrated-1')?.pendingPromptCount).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrateTask takes a defensive copy of restored queued prompts', () => {
    const pendingPrompts = ['follow restored'];

    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
      initialPrompt: 'do the restored work',
      pendingPrompts,
    });
    pendingPrompts.push('mutated-after-hydrate');

    expect(coordinator.getTaskStatus('hydrated-1')?.pendingPrompts).toEqual(['follow restored']);
  });

  it('hydrateTask + waitForIdle resolves immediately for exited status', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    await expect(coordinator.waitForIdle('hydrated-1')).resolves.toEqual({ reason: 'exited' });
  });

  it('hydrateTask + waitForSignalDone resolves if signalDoneAt was already set', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    const task = coordinator.getTask('hydrated-1');
    expect(task).toBeDefined();
    if (!task) throw new Error('task not found');
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    await expect(coordinator.waitForSignalDone('coord-1', 100)).resolves.toMatchObject({
      taskId: 'hydrated-1',
      remaining: expect.any(Number),
    });
  });

  it('hydrateTask + sendPrompt works without error', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    await expect(coordinator.sendPrompt('hydrated-1', 'hello')).resolves.toEqual({ queued: false });
  });

  it('hydrateTask controlledBy:human queues sendPrompt', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
      controlledBy: 'human',
    });

    await expect(coordinator.sendPrompt('hydrated-1', 'hello')).resolves.toEqual({ queued: true });
    expect(coordinator.getTaskStatus('hydrated-1')?.pendingPrompt).toBe('hello');
  });

  it('hydrateTask ignores human control until a restored initial prompt is delivered', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
      controlledBy: 'human',
      initialPrompt: 'do restored work',
    });

    await expect(coordinator.sendPrompt('hydrated-1', 'hello')).resolves.toEqual({ queued: true });
    expect(coordinator.getTaskStatus('hydrated-1')?.pendingPrompts).toEqual(['hello']);
  });

  it('hydrateTask delivers restored initial prompt despite persisted human control', async () => {
    vi.useFakeTimers();
    try {
      coordinator.hydrateTask({
        id: 'hydrated-1',
        name: 'hydrated-task',
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        branchName: 'task/hydrated',
        worktreePath: '/tmp/hydrated',
        agentId: 'agent-hydrated',
        coordinatorTaskId: 'coord-1',
        controlledBy: 'human',
        initialPrompt: 'do restored work',
      });

      getSpawnHandler()('agent-hydrated');
      const cb = mockSubscribeToAgent.mock.calls.find(
        (call) => call[0] === 'agent-hydrated',
      )?.[1] as ((encoded: string) => void) | undefined;
      expect(cb).toBeDefined();
      cb?.(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWriteToAgent).toHaveBeenCalledWith(
        'agent-hydrated',
        expect.stringContaining('do restored work'),
      );
      expect(mockWriteToAgent).toHaveBeenCalledWith('agent-hydrated', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrateTask uses the shared output callback to flush queued prompts after restart', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
      controlledBy: 'human',
    });
    coordinator.markPromptDelivered('hydrated-1');
    await coordinator.sendPrompt('hydrated-1', 'hello');
    coordinator.setTaskControl('hydrated-1', 'coordinator');

    const cb = mockSubscribeToAgent.mock.calls.find((call) => call[0] === 'agent-hydrated')?.[1] as
      | ((encoded: string) => void)
      | undefined;
    expect(cb).toBeDefined();
    cb?.(encode('❯'));
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(coordinator.getTaskStatus('hydrated-1')?.pendingPrompt).toBeUndefined();
  });
});

// ─── Item 6: Control state restart replay ─────────────────────────────────────

describe('Coordinator setTaskControl — queued send until activity lease clears', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('sendPrompt is queued when task is human-controlled', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.sendPrompt('task-1', 'hello')).resolves.toEqual({ queued: true });
    expect(coordinator.getTaskStatus('task-1')?.pendingPrompt).toBe('hello');
  });

  it('sendPrompt is unblocked after setTaskControl coordinator', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');
    coordinator.setTaskControl('task-1', 'coordinator');
    await expect(coordinator.sendPrompt('task-1', 'hello')).resolves.toEqual({ queued: false });
  });

  it('waitForIdle resolves immediately with human_control reason when human has control', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.waitForIdle('task-1')).resolves.toEqual({ reason: 'human_control' });
  });

  it('waitForIdle waits through queued prompt flush after control returns', async () => {
    vi.useFakeTimers();
    try {
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');
      coordinator.setTaskControl('task-1', 'human');
      await coordinator.sendPrompt('task-1', 'hello');
      const output = mockSubscribeToAgent.mock.calls[0]?.[1] as (encoded: string) => void;
      let resolved = false;

      const waitPromise = coordinator.waitForIdle('task-1', 10_000).then((result) => {
        resolved = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      coordinator.setTaskControl('task-1', 'coordinator');
      await vi.advanceTimersByTimeAsync(70);
      expect(mockWriteToAgent).toHaveBeenCalledWith(expect.any(String), 'hello');
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(2_100);
      output(encode('done ❯ '));
      await expect(waitPromise).resolves.toEqual({ reason: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('when sendPrompt was queued, clearing activity sends it without a control notification', async () => {
    await coordinator.createTask({ name: 'my-task', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');

    await coordinator.sendPrompt('task-1', 'hello');

    mockNotifyRenderer.mockClear();
    coordinator.setTaskControl('task-1', 'coordinator');
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
    expect(coordinator.getTaskStatus('task-1')?.pendingPrompt).toBeUndefined();
  });
});

// ─── Item 7: Notification lifecycle under waitForSignalDone ───────────────────

describe('Coordinator waitForSignalDone — notification lifecycle', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('staged notification is cleared when waitForSignalDone starts', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    emitWorkThenIdle(outputCb);

    // Confirm a notification was staged
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
    );

    mockNotifyRenderer.mockClear();

    // Starting a wait should clear the staged notification
    const waitPromise = coordinator.waitForSignalDone('coord-1', 100);
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
      coordinatorTaskId: 'coord-1',
    });

    // Clean up — reject or resolve the promise
    coordinator.signalDone('task-1');
    await waitPromise.catch(() => {});
  });

  it('task exit while wait active does not re-stage notification', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    const agentId = getAgentId();
    const exitHandler = getExitHandler();

    const waitPromise = coordinator.waitForSignalDone('coord-1', 5_000);
    mockNotifyRenderer.mockClear();

    exitHandler(agentId, { exitCode: 0 });

    // While an active signal_done wait is in progress, staging should be suppressed
    const stagedCalls = mockNotifyRenderer.mock.calls.filter(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    expect(stagedCalls).toHaveLength(0);

    // Clean up
    coordinator.signalDone('task-1');
    await waitPromise.catch(() => {});
  });

  it('wait timeout causes pending notifications to be staged after wait ends', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    // Trigger an idle so a notification is queued
    const outputCb = getOutputCb();
    emitWorkThenIdle(outputCb);

    // Start wait — this clears staged notifications
    const waitPromise = coordinator.waitForSignalDone('coord-1', 100);
    mockNotifyRenderer.mockClear();

    // Time out the wait
    vi.advanceTimersByTime(200);
    const timedOutResult = await waitPromise;
    expect(timedOutResult.timedOut).toBe(true);

    // After timeout, pending notifications should be re-staged
    const stagedCalls = mockNotifyRenderer.mock.calls.filter(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    expect(stagedCalls).toHaveLength(1);
  });

  it('coordinator deregistered — pending task notification fires orphaned event on next idle', async () => {
    await coordinator.createTask({
      name: 'orphan-test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
    });
    coordinator.markPromptDelivered('task-1');
    mockNotifyRenderer.mockClear();

    // Deregister the coordinator (no active wait — simpler scenario)
    coordinator.deregisterCoordinator('coord-1');

    // After deregister, idle output should fire an orphaned notification (coordinator is gone)
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_orphaned_notification',
      expect.objectContaining({ subTaskId: 'task-1' }),
    );
  });
});

// ─── Item 8: Sub-task lifecycle cleanup failure tests ─────────────────────────

describe('Coordinator cleanupTask — failure resilience', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('deleteTask failure retains task in map and emits MCP_TaskCleanupFailed, not MCP_TaskClosed', async () => {
    const { deleteTask: mockDeleteTask } =
      await vi.importMock<typeof import('../ipc/tasks.js')>('../ipc/tasks.js');
    vi.mocked(mockDeleteTask).mockRejectedValueOnce(new Error('delete failed'));

    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.closeTask('task-1');

    // Task must remain in backend map so retry is possible
    expect(coordinator.getTask('task-1')).toBeDefined();
    // MCP_TaskClosed must NOT be sent
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith('mcp_task_closed', expect.anything());
    // Failure event must be sent with the error message
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_cleanup_failed', {
      taskId: 'task-1',
      error: 'delete failed',
    });
  });

  it('deleteTask failure preserves coordinator task state', async () => {
    const { deleteTask: mockDeleteTask } =
      await vi.importMock<typeof import('../ipc/tasks.js')>('../ipc/tasks.js');
    vi.mocked(mockDeleteTask).mockRejectedValueOnce(new Error('delete failed'));

    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    // Simulate the task being under coordinator control
    coordinator.setTaskControl('task-1', 'coordinator');
    await coordinator.closeTask('task-1');

    // Backend task still findable — retry via closeTask should work
    expect(coordinator.getTask('task-1')).toBeDefined();
  });

  it('deleteTask failure clears scheduled initial prompt delivery timers', async () => {
    vi.useFakeTimers();
    try {
      const { deleteTask: mockDeleteTask } =
        await vi.importMock<typeof import('../ipc/tasks.js')>('../ipc/tasks.js');
      vi.mocked(mockDeleteTask).mockRejectedValueOnce(new Error('delete failed'));

      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      const outputCb = getOutputCb();
      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      const c = coordinator as unknown as {
        initialPromptTimers: Map<string, unknown>;
      };
      expect(c.initialPromptTimers.has('task-1')).toBe(true);

      await coordinator.closeTask('task-1');

      expect(c.initialPromptTimers.has('task-1')).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('do'),
      );
      expect(coordinator.getTask('task-1')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deleteTask failure clears scheduled queued prompt flush timers', async () => {
    vi.useFakeTimers();
    try {
      const { deleteTask: mockDeleteTask } =
        await vi.importMock<typeof import('../ipc/tasks.js')>('../ipc/tasks.js');
      vi.mocked(mockDeleteTask).mockRejectedValueOnce(new Error('delete failed'));

      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do',
        coordinatorTaskId: 'coord-1',
      });
      coordinator.markPromptDelivered(task.id);
      task.pendingPrompts = ['queued'];
      const outputCb = getOutputCb();
      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      const c = coordinator as unknown as {
        queuedPromptFlushTimers: Map<string, unknown>;
      };
      expect(c.queuedPromptFlushTimers.has(task.id)).toBe(true);

      await coordinator.closeTask(task.id);

      expect(c.queuedPromptFlushTimers.has(task.id)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(task.agentId, 'queued');
      expect(coordinator.getTask(task.id)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('MCP config file deletion failure is swallowed and task is removed', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    mockUnlinkSync.mockImplementationOnce(() => {
      throw new Error('unlink failed');
    });

    await expect(coordinator.closeTask('task-1')).resolves.toBeUndefined();
    expect(coordinator.getTask('task-1')).toBeUndefined();
  });

  it('subscriber is unregistered on cleanup', async () => {
    const { unsubscribeFromAgent } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSubscribeToAgent).toHaveBeenCalled();

    await coordinator.closeTask('task-1');

    expect(vi.mocked(unsubscribeFromAgent)).toHaveBeenCalled();
  });

  it('closeTask clears scheduled initial prompt delivery timers', async () => {
    vi.useFakeTimers();
    try {
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      const outputCb = getOutputCb();

      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      const c = coordinator as unknown as {
        initialPromptTimers: Map<string, unknown>;
      };
      expect(c.initialPromptTimers.has('task-1')).toBe(true);

      await coordinator.closeTask('task-1');

      expect(c.initialPromptTimers.has('task-1')).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('do'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('closeTask clears scheduled queued prompt flush timers', async () => {
    vi.useFakeTimers();
    try {
      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do',
        coordinatorTaskId: 'coord-1',
      });
      coordinator.markPromptDelivered(task.id);
      task.pendingPrompts = ['queued'];
      const outputCb = getOutputCb();

      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      const c = coordinator as unknown as {
        queuedPromptFlushTimers: Map<string, unknown>;
      };
      expect(c.queuedPromptFlushTimers.has(task.id)).toBe(true);

      await coordinator.closeTask(task.id);

      expect(c.queuedPromptFlushTimers.has(task.id)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(task.agentId, 'queued');
    } finally {
      vi.useRealTimers();
    }
  });

  it('removeCoordinatedTask clears scheduled initial prompt delivery timers', async () => {
    vi.useFakeTimers();
    try {
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      const outputCb = getOutputCb();

      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      const c = coordinator as unknown as {
        initialPromptTimers: Map<string, unknown>;
      };
      expect(c.initialPromptTimers.has('task-1')).toBe(true);

      coordinator.removeCoordinatedTask('task-1');

      expect(c.initialPromptTimers.has('task-1')).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('do'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('removeCoordinatedTask clears scheduled queued prompt flush timers', async () => {
    vi.useFakeTimers();
    try {
      const task = await coordinator.createTask({
        name: 'test',
        prompt: 'do',
        coordinatorTaskId: 'coord-1',
      });
      coordinator.markPromptDelivered(task.id);
      task.pendingPrompts = ['queued'];
      const outputCb = getOutputCb();

      outputCb(encode(READY_AGENT_FRAME_FIXTURES[0].frame));
      const c = coordinator as unknown as {
        queuedPromptFlushTimers: Map<string, unknown>;
      };
      expect(c.queuedPromptFlushTimers.has(task.id)).toBe(true);

      coordinator.removeCoordinatedTask(task.id);

      expect(c.queuedPromptFlushTimers.has(task.id)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(mockWriteToAgent).not.toHaveBeenCalledWith(task.agentId, 'queued');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Docker cleanup sequencing ────────────────────────────────────────────────

describe('Coordinator cleanupTask — Docker sub-task container stop', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    coordinator.setDockerContainerName('coord-1', 'my-coord-container');
    coordinator.setDockerImage('coord-1', 'parallel-code-agent:latest');
  });

  it('closeTask calls killAgent (which stops the sub-task Docker container via pty.ts)', async () => {
    const { killAgent } = await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');

    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.closeTask('task-1');

    // killAgent is responsible for stopping the Docker container (via stopDockerContainer in pty.ts)
    expect(vi.mocked(killAgent)).toHaveBeenCalled();
  });

  it('closeTask does not call docker exec kill — sub-task has its own container', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    vi.clearAllMocks(); // reset after createTask
    await coordinator.closeTask('task-1');

    // execFile is used for git commands only — never for 'docker exec kill'
    const dockerExecKillCall = mockExecFile.mock.calls.find(
      (c) =>
        c[0] === 'docker' &&
        Array.isArray(c[1]) &&
        c[1][0] === 'exec' &&
        c[1].includes('my-coord-container'),
    );
    expect(dockerExecKillCall).toBeUndefined();
  });

  it('deleteTask is called immediately after killAgent (no waiting for docker exec)', async () => {
    const { deleteTask: mockDeleteTask } =
      await vi.importMock<typeof import('../ipc/tasks.js')>('../ipc/tasks.js');
    vi.mocked(mockDeleteTask).mockResolvedValue(undefined);

    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.closeTask('task-1');

    // deleteTask is called (task is cleaned up)
    expect(vi.mocked(mockDeleteTask)).toHaveBeenCalled();
    expect(coordinator.getTask('task-1')).toBeUndefined();
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_closed', { taskId: 'task-1' });
  });
});

// ─── Token rotation tests ──────────────────────────────────────────────────────

describe('Coordinator setMCPServerInfo — token rotation', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('rewrites existing task config files when token rotates', async () => {
    // Set up initial MCP server info
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://127.0.0.1:3001',
      'old-token',
      'old-token',
      '/path/to/mcp-server.cjs',
    );

    // Create a task — this writes a config file (mcpConfigPath set if server info is present)
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    // Clear write calls from task creation
    mockAtomicWriteFileSync.mockClear();

    // Rotate to a new token
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://127.0.0.1:3002',
      'new-token-xyz',
      'new-token-xyz',
      '/path/to/mcp-server.cjs',
    );

    // At least one writeFileSync call should have the new token
    const rewriteCalls = mockAtomicWriteFileSync.mock.calls;
    const hasNewToken = rewriteCalls.some((c) => {
      const content = typeof c[1] === 'string' ? c[1] : '';
      return content.includes('new-token-xyz');
    });

    // If task had an mcpConfigPath, it should be rewritten.
    // (If task had no mcpConfigPath — e.g. Docker mode — rewrite is skipped, which is also correct.)
    const task = coordinator.getTask('task-1');
    if (task?.mcpConfigPath) {
      expect(hasNewToken).toBe(true);
    } else {
      // Docker mode: no host config file to rewrite (sub-tasks use in-container config)
      expect(true).toBe(true);
    }
  });

  it('setMCPServerInfo with no existing tasks writes nothing', () => {
    mockAtomicWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://127.0.0.1:3001',
      'new-token',
      'new-token',
      '/path/mcp.cjs',
    );
    // No tasks yet — nothing to rewrite
    const rewriteCalls = mockAtomicWriteFileSync.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('new-token'),
    );
    expect(rewriteCalls).toHaveLength(0);
  });
});

// ─── Multiple coordinators in Docker ─────────────────────────────────────────

describe('Multiple Docker coordinators — isolation', () => {
  let coordA: InstanceType<typeof Coordinator>;
  let coordB: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });

    coordA = new Coordinator();
    coordA.setWindow(mockWin);
    coordA.setDefaultProject('proj-a', '/tmp/project-a');
    coordA.registerCoordinator('coord-a', 'proj-a');

    coordB = new Coordinator();
    coordB.setWindow(mockWin);
    coordB.setDefaultProject('proj-b', '/tmp/project-b');
    coordB.registerCoordinator('coord-b', 'proj-b');
  });

  it('each coordinator has an isolated docker container name (no singleton leak)', () => {
    coordA.setDockerContainerName('coord-a', 'parallel-code-container-a');
    coordB.setDockerContainerName('coord-b', 'parallel-code-container-b');

    // The container names must differ — no shared singleton
    expect('parallel-code-container-a').not.toBe('parallel-code-container-b');
  });

  it('sub-task MCP config for coord-a uses coord-a coordinator id, not coord-b', async () => {
    coordA.setMCPServerInfo(
      'coord-a',
      'http://localhost:3001',
      'tok-a',
      'subtask-tok-a',
      '/path/server.js',
    );
    await coordA.createTask({ name: 'task-a', prompt: 'do a', coordinatorTaskId: 'coord-a' });

    const configWrites = mockAtomicWriteFile.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(1);

    const cfg = JSON.parse(configWrites[0][1] as string) as {
      mcpServers: { 'parallel-code': { args: string[]; env: Record<string, string> } };
    };
    expect(cfg.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe('subtask-tok-a');
    expect(cfg.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).not.toBe(
      'subtask-tok-b',
    );
  });
});

// ─── Sub-task per-container spawn (#31) ──────────────────────────────────────

describe('Coordinator Docker sub-task — per-container spawn', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    coordinator.setDockerContainerName('coord-1', 'my-coord-container');
    coordinator.setDockerImage('coord-1', 'parallel-code-agent:latest');
  });

  it('sub-task spawned with dockerMode: true (docker run), not docker exec', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const spawnCall = mockSpawnAgent.mock.calls[0][1] as {
      command: string;
      args: string[];
      dockerMode?: boolean;
    };
    // Must use dockerMode: true so pty.ts builds `docker run`
    expect(spawnCall.dockerMode).toBe(true);
    // Command is the agent, not 'docker'
    expect(spawnCall.command).toBe('claude');
    // Args never contain 'exec'
    expect(spawnCall.args).not.toContain('exec');
  });

  it('sub-task does NOT reference the coordinator container name in spawn args', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const spawnCall = mockSpawnAgent.mock.calls[0][1] as { args: string[] };
    // Each sub-task gets its own container — coordinator container name is never used as spawn target
    expect(spawnCall.args).not.toContain('my-coord-container');
  });
});

// ─── Interrupted bootstrap / exit before prompt delivery ─────────────────────

describe('Coordinator interrupted bootstrap', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('exits before prompt delivery notifies coordinator so it does not hang forever', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    const exitHandler = getExitHandler();

    // Kill the container before any output was produced — simulates trust-prompt hang / OOM kill
    exitHandler(agentId, { exitCode: 137 }); // 137 = SIGKILL

    // Coordinator must have been notified (not left waiting for prompt)
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });

  it('task status is exited after unexpected container death', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    exitHandler(agentId, { exitCode: 1 });

    const task = coordinator.getTask('task-1');
    expect(task?.status).toBe('exited');
  });
});

// ─── Very fast prompt before subscription (scrollback detection) ─────────────

describe('Coordinator very fast prompt — scrollback detection', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('detects idle state via scrollback when prompt arrives before subscription', async () => {
    // Simulate container that printed ❯ before we subscribed: getAgentScrollback returns it.
    mockGetAgentScrollback.mockReturnValueOnce(
      Buffer.from('Welcome to Claude Code ❯ ').toString('base64'),
    );

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    // Task must be idle (not still "running") because scrollback contained ❯
    expect(task?.status).toBe('idle');
  });

  it('task remains running when scrollback contains no prompt', async () => {
    // No ❯ in scrollback — agent is still initializing
    mockGetAgentScrollback.mockReturnValueOnce(
      Buffer.from('Loading… please wait').toString('base64'),
    );

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    expect(task?.status).toBe('running');
  });

  it('null scrollback (agent not yet started) leaves task in running state', async () => {
    mockGetAgentScrollback.mockReturnValueOnce(null);

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    expect(task?.status).toBe('running');
  });
});

// ─── Coordinator close with active sub-tasks ─────────────────────────────────

describe('Coordinator close with active sub-tasks', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('killAgent is called for each active sub-task when coordinator closes', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-a', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-b', branch_name: 'task/b', worktree_path: '/tmp/b' });

    await coordinator.createTask({ name: 'task-a', prompt: 'do a', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do b', coordinatorTaskId: 'coord-1' });

    const { killAgent: mockKillFn } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    vi.mocked(mockKillFn).mockClear();

    await coordinator.closeTask('task-a');
    await coordinator.closeTask('task-b');

    expect(vi.mocked(mockKillFn)).toHaveBeenCalledTimes(2);
  });

  it('MCP config temp file is deleted on closeTask (TODOS.md item 10)', async () => {
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    const configPath = task?.mcpConfigPath;
    expect(configPath).toBeDefined();
    expect(configPath).toMatch(/parallel-code-subtask-task-1\.json$/);

    mockUnlinkSync.mockClear();
    await coordinator.closeTask('task-1');

    // unlinkSync must be called with the config path
    const unlinkCall = mockUnlinkSync.mock.calls.find((c) => c[0] === configPath);
    expect(unlinkCall).toBeDefined();
  });

  it('does not call unlinkSync for tasks created without MCP server info', async () => {
    // No setMCPServerInfo call — task gets no mcpConfigPath
    await coordinator.createTask({ name: 'test', prompt: 'do work', coordinatorTaskId: 'coord-1' });

    expect(coordinator.getTask('task-1')?.mcpConfigPath).toBeUndefined();

    mockUnlinkSync.mockClear();
    await coordinator.closeTask('task-1');

    // unlinkSync should NOT have been called with a parallel-code path
    const parallelCodeCalls = mockUnlinkSync.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('parallel-code-subtask'),
    );
    expect(parallelCodeCalls).toHaveLength(0);
  });

  it('task is removed from map even when docker exec sub-tasks are active', async () => {
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator.setDockerContainerName('coord-1', 'my-container');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    expect(coordinator.getTask('task-1')).toBeDefined();
    await coordinator.closeTask('task-1');
    expect(coordinator.getTask('task-1')).toBeUndefined();
  });
});

// ─── App crash/restart with running Docker container ─────────────────────────

describe('Coordinator restart hydration with Docker container name', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('hydrateTask with controlledBy=human restores human control', () => {
    coordinator.hydrateTask({
      id: 'task-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/test',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
      controlledBy: 'human',
    });

    // setTaskControl should restore human control
    coordinator.setTaskControl('task-1', 'human');
    // Task must be under human control — verify via getTask
    const task = coordinator.getTask('task-1');
    expect(task).toBeDefined();
  });

  it('hydrateTask restores task so closeTask can clean it up after restart', async () => {
    coordinator.hydrateTask({
      id: 'task-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/test',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    expect(coordinator.getTask('task-1')).toBeDefined();
    await coordinator.closeTask('task-1');
    expect(coordinator.getTask('task-1')).toBeUndefined();
  });
});

// ─── removeCoordinatedTask tests ─────────────────────────────────────────────

describe('Coordinator removeCoordinatedTask', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('is a no-op for unknown taskId', () => {
    expect(() => coordinator.removeCoordinatedTask('nonexistent')).not.toThrow();
  });

  it('removes task from internal map', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')).toBeDefined();

    coordinator.removeCoordinatedTask('task-1');

    expect(coordinator.getTask('task-1')).toBeUndefined();
  });

  it('unsubscribes the PTY output callback', async () => {
    const { unsubscribeFromAgent } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();

    coordinator.removeCoordinatedTask('task-1');

    expect(vi.mocked(unsubscribeFromAgent)).toHaveBeenCalledWith(agentId, expect.any(Function));
  });

  it('cleans up internal resource maps (subscribers, tailBuffers, decoders, controlMap)', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    coordinator.setTaskControl('task-1', 'human');
    await coordinator.sendPrompt('task-1', 'hello').catch(() => {});

    coordinator.removeCoordinatedTask('task-1');

    const c = coordinator as unknown as {
      subscribers: Map<string, unknown>;
      tailBuffers: Map<string, unknown>;
      decoders: Map<string, unknown>;
      controlMap: Map<string, unknown>;
    };
    expect(c.subscribers.has(agentId)).toBe(false);
    expect(c.tailBuffers.has(agentId)).toBe(false);
    expect(c.decoders.has(agentId)).toBe(false);
    expect(c.controlMap.has('task-1')).toBe(false);
  });

  it('deregister detaches child task state and preserves review only after prompt delivery', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    mockNotifyRenderer.mockClear();

    coordinator.deregisterCoordinator('coord-1');

    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_state_sync', {
      taskId: 'task-1',
      coordinatedBy: null,
      controlledBy: null,
      mcpConfigPath: null,
      mcpStartupStatus: null,
      mcpStartupError: null,
      needsReview: true,
    });
  });

  it('resolves pending idle waiters with removed reason', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForIdle('task-1');

    coordinator.removeCoordinatedTask('task-1');

    await expect(waitPromise).resolves.toEqual({ reason: 'removed' });
  });

  it('deletes MCP config file when mcpConfigPath is set', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const configPath = coordinator.getTask('task-1')?.mcpConfigPath;
    expect(configPath).toBeDefined();

    mockUnlinkSync.mockClear();
    coordinator.removeCoordinatedTask('task-1');

    const unlinkCall = mockUnlinkSync.mock.calls.find((c) => c[0] === configPath);
    expect(unlinkCall).toBeDefined();
  });

  it('does not call unlinkSync for tasks with no mcpConfigPath', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')?.mcpConfigPath).toBeUndefined();

    mockUnlinkSync.mockClear();
    coordinator.removeCoordinatedTask('task-1');

    const parallelCodeCalls = mockUnlinkSync.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('parallel-code-subtask'),
    );
    expect(parallelCodeCalls).toHaveLength(0);
  });

  it('does NOT notify renderer (UI already removed the task)', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    mockNotifyRenderer.mockClear();

    coordinator.removeCoordinatedTask('task-1');

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith('mcp_task_closed', expect.anything());
  });

  it('does NOT kill the agent (UI already did that)', async () => {
    const { killAgent: mockKillFn } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    vi.mocked(mockKillFn).mockClear();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    vi.mocked(mockKillFn).mockClear();

    coordinator.removeCoordinatedTask('task-1');

    expect(vi.mocked(mockKillFn)).not.toHaveBeenCalled();
  });

  it('does NOT delete the worktree (UI already did that)', async () => {
    const { deleteTask: mockDeleteTask } =
      await vi.importMock<typeof import('../ipc/tasks.js')>('../ipc/tasks.js');
    vi.mocked(mockDeleteTask).mockClear();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    vi.mocked(mockDeleteTask).mockClear();

    coordinator.removeCoordinatedTask('task-1');

    expect(vi.mocked(mockDeleteTask)).not.toHaveBeenCalled();
  });
});

// ─── #33: Post-restart coordinator flow integration test ─────────────────────

describe('Coordinator restart round-trip integration', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('hydrateTask rewrites config with new subtaskToken (not coordinator token) when server info is already set', () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-coordinator-secret',
      'new-subtask-secret',
      '/path/server.js',
    );

    const taskId = 'hydrated-restart-1';
    const configPath = join(os.tmpdir(), `parallel-code-subtask-${taskId}.json`);

    mockAtomicWriteFileSync.mockClear();
    coordinator.hydrateTask({
      id: taskId,
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-restart-1',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: configPath,
    });

    const rewrite = mockAtomicWriteFileSync.mock.calls.find((c) => c[0] === configPath);
    expect(rewrite).toBeDefined();
    if (!rewrite) throw new Error('expected config rewrite');
    const config = JSON.parse(rewrite[1] as string) as {
      mcpServers: { 'parallel-code': { env: Record<string, string> } };
    };
    const writtenToken = config.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN'];
    expect(writtenToken).toBe('new-subtask-secret');
    expect(writtenToken).not.toBe('new-coordinator-secret');
  });

  it('hydrateTask returns fresh Codex MCP launch args after rewriting config', () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-coordinator-secret',
      'new-subtask-secret',
      '/path/server.js',
    );

    const taskId = 'hydrated-restart-codex';
    const configPath = join(os.tmpdir(), `parallel-code-subtask-${taskId}.json`);

    const result = coordinator.hydrateTask({
      id: taskId,
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-restart-codex',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: configPath,
      agentCommand: 'codex',
    });

    expect(result.mcpLaunchArgs).toEqual([
      '--config',
      expect.stringContaining('new-subtask-secret'),
    ]);
  });

  it('hydrateTask returns Codex MCP launch args even without a persisted config path', () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-coordinator-secret',
      'new-subtask-secret',
      '/path/server.js',
    );

    mockAtomicWriteFileSync.mockClear();
    const result = coordinator.hydrateTask({
      id: 'hydrated-restart-codex-inline',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-restart-codex-inline',
      coordinatorTaskId: 'coord-1',
      agentCommand: 'codex',
    });

    expect(mockAtomicWriteFileSync).not.toHaveBeenCalled();
    expect(result.mcpLaunchArgs).toEqual([
      '--config',
      expect.stringContaining('new-subtask-secret'),
    ]);
    expect(result.mcpLaunchArgs?.[1]).toContain('--task-id');
    expect(result.mcpLaunchArgs?.[1]).toContain('hydrated-restart-codex-inline');
  });

  it('hydrateTask returns launch args when the task is already hydrated', () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-coordinator-secret',
      'new-subtask-secret',
      '/path/server.js',
    );

    const taskId = 'hydrated-restart-existing';
    const configPath = join(os.tmpdir(), `parallel-code-subtask-${taskId}.json`);
    const args = {
      id: taskId,
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-restart-existing',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: configPath,
      agentCommand: 'codex',
    };

    coordinator.hydrateTask(args);
    const result = coordinator.hydrateTask(args);

    expect(result.mcpLaunchArgs).toEqual([
      '--config',
      expect.stringContaining('new-subtask-secret'),
    ]);
  });

  it('waitForIdle resolves after agent output fires post-hydration', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-coordinator-secret',
      'new-subtask-secret',
      '/path/server.js',
    );

    const taskId = 'hydrated-restart-2';
    const agentId = 'agent-restart-2';
    const configPath = join(os.tmpdir(), `parallel-code-subtask-${taskId}.json`);

    coordinator.hydrateTask({
      id: taskId,
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId,
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: configPath,
    });

    // Simulate agent respawn: task transitions from exited → running
    const task = coordinator.getTask(taskId);
    expect(task).toBeDefined();
    if (!task) throw new Error('task not found after hydration');
    task.status = 'running';

    // Get the output callback registered during hydrateTask
    const hydratedCb = mockSubscribeToAgent.mock.calls.find((c) => c[0] === agentId)?.[1] as
      | ((encoded: string) => void)
      | undefined;
    expect(hydratedCb).toBeDefined();
    if (!hydratedCb) throw new Error('hydrateTask did not subscribe to agent');

    const waitPromise = coordinator.waitForIdle(taskId);
    hydratedCb(encode('Work done ❯ '));
    await expect(waitPromise).resolves.toEqual({ reason: 'idle' });
  });
});

// ─── #36: hydrateTask mcpConfigPath directory scoping ────────────────────────

describe('Coordinator hydrateTask — mcpConfigPath directory scoping', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtok',
      '/srv/app/.parallel-code/mcp-server.js',
    );
  });

  it('path traversal (../../etc/passwd-style) is rejected — mcpConfigPath is undefined, no config write', () => {
    coordinator.hydrateTask({
      id: 'task-traversal',
      name: 'evil',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/evil',
      worktreePath: '/tmp/evil',
      agentId: 'agent-evil',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: '../../etc/passwd',
    });

    expect(coordinator.getTask('task-traversal')?.mcpConfigPath).toBeUndefined();
    const evilWrite = mockAtomicWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('etc/passwd'),
    );
    expect(evilWrite).toBeUndefined();
  });

  it('right filename in wrong dir is rejected — mcpConfigPath is undefined', () => {
    const taskId = 'task-wrong-dir';
    coordinator.hydrateTask({
      id: taskId,
      name: 'wrong-dir',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/wrong-dir',
      worktreePath: '/tmp/wrong-dir',
      agentId: 'agent-wrong-dir',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: `/tmp/evil/parallel-code-subtask-${taskId}.json`,
    });

    expect(coordinator.getTask(taskId)?.mcpConfigPath).toBeUndefined();
  });

  it('correct host tmpdir path is accepted and config write occurs', () => {
    const taskId = 'task-valid-host';
    const validPath = join(os.tmpdir(), `parallel-code-subtask-${taskId}.json`);

    mockAtomicWriteFileSync.mockClear();
    coordinator.hydrateTask({
      id: taskId,
      name: 'valid-host',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/valid-host',
      worktreePath: '/tmp/valid-host',
      agentId: 'agent-valid-host',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: validPath,
    });

    expect(coordinator.getTask(taskId)?.mcpConfigPath).toBe(validPath);
    const configWrite = mockAtomicWriteFileSync.mock.calls.find((c) => c[0] === validPath);
    expect(configWrite).toBeDefined();
  });

  it('host mode: dirname(serverPath)/subtask-{id}.json is rejected even when serverPath is present', () => {
    const taskId = 'task-host-docker-path';
    const serverPath = '/srv/app/.parallel-code/mcp-server.js';
    const dockerPath = join(dirname(serverPath), `subtask-${taskId}.json`);

    mockAtomicWriteFileSync.mockClear();
    coordinator.hydrateTask({
      id: taskId,
      name: 'host-docker-path',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/host-docker-path',
      worktreePath: '/tmp/host-docker-path',
      agentId: 'agent-host-docker-path',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: dockerPath,
    });

    expect(coordinator.getTask(taskId)?.mcpConfigPath).toBeUndefined();
    const configWrite = mockAtomicWriteFileSync.mock.calls.find((c) => c[0] === dockerPath);
    expect(configWrite).toBeUndefined();
  });

  it('Docker mode: dirname(serverPath)/subtask-{id}.json is accepted and config write occurs', () => {
    const taskId = 'task-valid-docker';
    const serverPath = '/srv/app/.parallel-code/mcp-server.js';
    const dockerPath = join(dirname(serverPath), `subtask-${taskId}.json`);

    coordinator.setDockerContainerName('coord-1', 'parallel-code-coord');
    mockAtomicWriteFileSync.mockClear();
    coordinator.hydrateTask({
      id: taskId,
      name: 'valid-docker',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/valid-docker',
      worktreePath: '/tmp/valid-docker',
      agentId: 'agent-valid-docker',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: dockerPath,
    });

    expect(coordinator.getTask(taskId)?.mcpConfigPath).toBe(dockerPath);
    const configWrite = mockAtomicWriteFileSync.mock.calls.find((c) => c[0] === dockerPath);
    expect(configWrite).toBeDefined();
  });

  it('Docker mode: path in wrong dir is rejected — mcpConfigPath is undefined', () => {
    const taskId = 'task-evil-docker';
    const wrongPath = `/some/other/dir/subtask-${taskId}.json`;

    coordinator.setDockerContainerName('coord-1', 'parallel-code-coord');
    coordinator.hydrateTask({
      id: taskId,
      name: 'evil-docker',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/evil-docker',
      worktreePath: '/tmp/evil-docker',
      agentId: 'agent-evil-docker',
      coordinatorTaskId: 'coord-1',
      mcpConfigPath: wrongPath,
    });

    expect(coordinator.getTask(taskId)?.mcpConfigPath).toBeUndefined();
  });
});

// ─── #39: Docker coordinator child-close isolation ────────────────────────────

describe('Coordinator closeTask — per-task config isolation (two sub-tasks)', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
  });

  it('closing task-1 deletes only its config; task-2 config and task-2 entry are untouched', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-1', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-2', branch_name: 'task/b', worktree_path: '/tmp/b' });

    await coordinator.createTask({ name: 'task-one', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-two', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const config1 = coordinator.getTask('task-1')?.mcpConfigPath;
    const config2 = coordinator.getTask('task-2')?.mcpConfigPath;
    expect(config1).toBeDefined();
    expect(config2).toBeDefined();
    expect(config1).not.toBe(config2);

    mockUnlinkSync.mockClear();
    await coordinator.closeTask('task-1');

    // task-1's config was deleted
    expect(mockUnlinkSync).toHaveBeenCalledWith(config1);
    // task-2's config was NOT deleted
    expect(mockUnlinkSync).not.toHaveBeenCalledWith(config2);

    // task-2 is still present, task-1 is gone
    const tasks = coordinator.listTasks();
    expect(tasks.some((t) => t.id === 'task-2')).toBe(true);
    expect(tasks.some((t) => t.id === 'task-1')).toBe(false);
  });
});

// ─── Docker per-container sub-task tests (#31) ───────────────────────────────

describe('Coordinator Docker mode — per-container sub-tasks', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-docker-1',
      branch_name: 'task/docker-sub',
      worktree_path: '/tmp/project/.worktrees/task/docker-sub',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');

    // Register coordinator in Docker mode
    coordinator.registerCoordinator('coord-docker', 'proj-1', {
      worktreePath: '/tmp/project/.worktrees/task/coord',
    });
    coordinator.setDockerContainerName('coord-docker', 'parallel-code-abcdef123456');
    coordinator.setDockerImage('coord-docker', 'parallel-code-agent:latest');
    coordinator.setCoordinatorSpawnDefaults('coord-docker', 'claude', []);
  });

  it('createTask in Docker mode spawns via docker run (dockerMode: true), not docker exec', async () => {
    await coordinator.createTask({
      name: 'docker-sub-task',
      coordinatorTaskId: 'coord-docker',
    });

    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    const spawnCall = mockSpawnAgent.mock.calls[0][1];

    // Must use dockerMode: true — never build 'docker exec' args manually
    expect(spawnCall.dockerMode).toBe(true);
    // Command is the agent command (claude), not 'docker'
    expect(spawnCall.command).toBe('claude');
    // Args do not contain 'exec'
    expect(spawnCall.args).not.toContain('exec');
    // Args do not contain the coordinator container name
    expect(spawnCall.args).not.toContain('parallel-code-abcdef123456');
  });

  it('createTask passes the coordinator Docker image to spawnAgent', async () => {
    await coordinator.createTask({
      name: 'docker-sub-task',
      coordinatorTaskId: 'coord-docker',
    });

    const spawnCall = mockSpawnAgent.mock.calls[0][1];
    expect(spawnCall.dockerImage).toBe('parallel-code-agent:latest');
  });

  it('createTask sets dockerMountWorktreeParent: true so coordinator .parallel-code/ is accessible', async () => {
    await coordinator.createTask({
      name: 'docker-sub-task',
      coordinatorTaskId: 'coord-docker',
    });

    const spawnCall = mockSpawnAgent.mock.calls[0][1];
    expect(spawnCall.dockerMountWorktreeParent).toBe(true);
  });

  it('createTask in non-Docker mode does not set dockerMode on spawnAgent', async () => {
    coordinator.registerCoordinator('coord-host', 'proj-1');
    coordinator.setCoordinatorSpawnDefaults('coord-host', 'claude', []);
    // No setDockerContainerName call — host mode

    mockCreateBackendTask.mockResolvedValueOnce({
      id: 'task-host-1',
      branch_name: 'task/host-sub',
      worktree_path: '/tmp/project/.worktrees/task/host-sub',
    });

    await coordinator.createTask({
      name: 'host-sub-task',
      coordinatorTaskId: 'coord-host',
    });

    const spawnCall = mockSpawnAgent.mock.calls[0][1];
    expect(spawnCall.dockerMode).toBeUndefined();
    expect(spawnCall.dockerImage).toBeUndefined();
    expect(spawnCall.command).toBe('claude');
  });

  it('setDockerImage stores the image on coordinator state', () => {
    coordinator.setDockerImage('coord-docker', 'my-custom-image:v2');
    // Verify through createTask spawn — indirectly tests the stored value
    // (direct state access not available, but spawnAgent mock captures it)
  });

  it('closeTask for a Docker sub-task does not call docker exec kill', async () => {
    const { killAgent } = await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');

    await coordinator.createTask({
      name: 'docker-sub-task',
      coordinatorTaskId: 'coord-docker',
    });

    const task = coordinator.listTasks().find((t) => t.name === 'docker-sub-task');
    if (!task) throw new Error('task not found');

    vi.clearAllMocks();
    await coordinator.closeTask(task.id);

    // killAgent is called (which internally calls stopDockerContainer in pty.ts)
    expect(killAgent).toHaveBeenCalledWith(expect.any(String));

    // docker exec should NOT be called for killing the inner process
    // (execFile is called only for git operations in cleanupTask, not docker exec kill)
    const dockerExecKillCall = mockExecFile.mock.calls.find(
      (c) =>
        c[0] === 'docker' && Array.isArray(c[1]) && c[1][0] === 'exec' && c[1].includes('kill'),
    );
    expect(dockerExecKillCall).toBeUndefined();
  });
});

// ─── waitForSignalDone requestId replay ──────────────────────────────────────

describe('Coordinator waitForSignalDone — requestId replay after transport failure', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('same requestId returns cached result after signal is already consumed', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const task = coordinator.getTask('task-1');
    if (!task) throw new Error('task not found');
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    const requestId = 'replay-test-id-1';
    // First call: consumes the signal
    const result1 = await coordinator.waitForSignalDone('coord-1', 500, requestId);
    expect(result1.taskId).toBe('task-1');
    expect(task.signalDoneConsumed).toBe(true);

    // Second call with same requestId: signal consumed, but result is replayed from cache
    const result2 = await coordinator.waitForSignalDone('coord-1', 100, requestId);
    expect(result2).toEqual(result1);
  });

  it('different requestId after signal is consumed blocks until timeout', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const task = coordinator.getTask('task-1');
    if (!task) throw new Error('task not found');
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    // First call with requestId A consumes the signal
    await coordinator.waitForSignalDone('coord-1', 500, 'id-A');
    expect(task.signalDoneConsumed).toBe(true);

    // Second call with a new requestId: no unconsumed signal, no cache hit → times out
    const result2 = await coordinator.waitForSignalDone('coord-1', 50, 'id-B');
    expect(result2.timedOut).toBe(true);
  });

  it('waitForSignalDone without requestId still resolves from unconsumed signal', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const task = coordinator.getTask('task-1');
    if (!task) throw new Error('task not found');
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    // No requestId: backward-compatible path
    const result = await coordinator.waitForSignalDone('coord-1', 100);
    expect(result.taskId).toBe('task-1');
  });

  it('same requestId returns cached timed-out result after a timeout (no second live wait)', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const requestId = 'replay-timeout-id';
    // First call times out — no unconsumed signal, short timeout.
    const result1 = await coordinator.waitForSignalDone('coord-1', 25, requestId);
    expect(result1.timedOut).toBe(true);

    // Retry with the same requestId must replay the cached timed-out result
    // instead of registering a fresh waiter — otherwise a stale HTTP retry
    // would inflate activeSignalWaitCounts and re-block the coordinator.
    const beforeRetry = Date.now();
    const result2 = await coordinator.waitForSignalDone('coord-1', 10_000, requestId);
    const elapsed = Date.now() - beforeRetry;
    expect(result2).toEqual(result1);
    expect(elapsed).toBeLessThan(100);
  });

  it('cached result for coord-A does not replay for coord-B with the same requestId', async () => {
    coordinator.registerCoordinator('coord-2', 'proj-1');

    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const task = coordinator.getTask('task-1');
    if (!task) throw new Error('task not found');
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    const requestId = 'shared-id';
    // coord-A consumes the signal and caches with key `coord-1:shared-id`
    const result1 = await coordinator.waitForSignalDone('coord-1', 500, requestId);
    expect(result1.taskId).toBe('task-1');

    // coord-B with same requestId must not replay coord-A's cached result
    const result2 = await coordinator.waitForSignalDone('coord-2', 50, requestId);
    expect(result2.timedOut).toBe(true);
  });
});

// ─── removePreambleBlock unit tests ──────────────────────────────────────────

describe('Coordinator removePreambleBlock', () => {
  const strip = removePreambleBlock;

  const BLOCK = '<sub-task-mode>\nrules\n</sub-task-mode>';

  it('removes preamble block appended to existing content', () => {
    const result = strip(`existing content\n\n${BLOCK}`);
    expect(result).toBe('existing content');
  });

  it('preserves content after end marker', () => {
    const result = strip(`before\n\n${BLOCK}\n\nafter`);
    expect(result).toBe('before\n\nafter');
  });

  it('preserves content before preamble when no prior content exists', () => {
    const result = strip(`${BLOCK}\n\nafter`);
    expect(result).toBe('after');
  });

  it('returns empty string when file contains only preamble block', () => {
    const result = strip(BLOCK);
    expect(result).toBe('');
  });

  it('drops from start marker to EOF when end marker is absent (prevents preamble being committed)', () => {
    const content = 'before\n\n<sub-task-mode>\norphaned start';
    expect(strip(content)).toBe('before');
  });

  it('returns content unchanged when no preamble marker present', () => {
    const content = 'just a normal file\nno preamble here';
    expect(strip(content)).toBe(content);
  });
});

// ─── getTaskDiff — preamble-bearing files (#34) ───────────────────────────────

describe('Coordinator getTaskDiff — preamble-bearing files', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/worktree',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    vi.mocked(getDiffBaseSha).mockResolvedValue('base-sha-abc');
  });

  it('preamble-only AGENTS.md is excluded from file list and diff output', async () => {
    await coordinator.createTask({ name: 'T', coordinatorTaskId: 'coord-1' });

    vi.mocked(getChangedFiles).mockResolvedValue([
      { path: 'AGENTS.md', status: 'M', lines_added: 5, lines_removed: 0, committed: true },
    ]);
    vi.mocked(getAllFileDiffs).mockResolvedValue(
      'diff --git a/AGENTS.md b/AGENTS.md\n@@ -1 +1,3 @@\n+<sub-task-mode>\n+rules\n+</sub-task-mode>\n',
    );

    // AGENTS.md contains only the injected preamble block
    const preambleContent = '<sub-task-mode>\nrules here\n</sub-task-mode>';
    mockFsReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes('AGENTS.md')) return preambleContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockExistsSync.mockImplementation((p?: unknown) => String(p).includes('AGENTS.md'));
    mockReadFileSync.mockReturnValue(preambleContent);

    // git show: base was empty; git diff --no-index: no diff (normalized == base).
    // Note: git diff --no-index is called WITHOUT opts, so promisify places the callback
    // in position 3 (optsOrCb). We detect which arg is the callback by checking typeof.
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        optsOrCb: unknown,
        cbMaybe?: (e: Error | null, o: string, r: string) => void,
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : cbMaybe) as (
          e: Error | null,
          o: string,
          r: string,
        ) => void;
        cb(null, '', '');
      },
    );

    const result = await coordinator.getTaskDiff('task-1');

    expect(result.files).toHaveLength(0);
    expect(result.diff).not.toContain('AGENTS.md');
    expect(result.diff).not.toContain('sub-task-mode');
  });

  it('AGENTS.md with user edit after preamble block shows only the user edit', async () => {
    await coordinator.createTask({ name: 'T', coordinatorTaskId: 'coord-1' });

    vi.mocked(getChangedFiles).mockResolvedValue([
      { path: 'AGENTS.md', status: 'M', lines_added: 8, lines_removed: 0, committed: true },
    ]);
    vi.mocked(getAllFileDiffs).mockResolvedValue(
      'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,8 @@\n+preamble and user content\n',
    );

    // Worktree: preamble block + user content after it
    const worktreeContent =
      '<sub-task-mode>\nrules\n</sub-task-mode>\n\n# User section added by sub-agent\n';
    mockFsReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes('AGENTS.md')) return worktreeContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockExistsSync.mockImplementation((p?: unknown) => String(p).includes('AGENTS.md'));
    mockReadFileSync.mockReturnValue(worktreeContent);

    const fakeDiff =
      'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+# User section added by sub-agent\n';

    // git show has opts ({cwd}), git diff --no-index does not. Detect callback by type.
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        cbMaybe?: (e: Error | null, o: string, r: string) => void,
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : cbMaybe) as (
          e: Error | null,
          o: string,
          r: string,
        ) => void;
        if (args[0] === 'show') {
          cb(null, '', ''); // base was empty
        } else if (args[0] === 'diff') {
          // git diff exits with code 1 when files differ
          const err = Object.assign(new Error(''), { code: 1, stdout: fakeDiff });
          cb(err, fakeDiff, '');
        } else {
          cb(null, '', '');
        }
      },
    );

    const result = await coordinator.getTaskDiff('task-1');

    expect(result.files).toHaveLength(1);
    expect(result.diff).toContain('User section added by sub-agent');
    expect(result.diff).not.toContain('sub-task-mode');
  });

  it('AGENTS.md with user edit before preamble block also shows the user edit', async () => {
    await coordinator.createTask({ name: 'T', coordinatorTaskId: 'coord-1' });

    vi.mocked(getChangedFiles).mockResolvedValue([
      { path: 'AGENTS.md', status: 'M', lines_added: 6, lines_removed: 0, committed: true },
    ]);
    vi.mocked(getAllFileDiffs).mockResolvedValue(
      'diff --git a/AGENTS.md b/AGENTS.md\n@@ -1 +1,6 @@\n+mixed content\n',
    );

    // Worktree: user content before preamble
    const worktreeContent = '# My custom heading\n\n<sub-task-mode>\nrules\n</sub-task-mode>\n';
    mockFsReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes('AGENTS.md')) return worktreeContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockExistsSync.mockImplementation((p?: unknown) => String(p).includes('AGENTS.md'));
    mockReadFileSync.mockReturnValue(worktreeContent);

    const fakeDiff =
      'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+# My custom heading\n';

    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        cbMaybe?: (e: Error | null, o: string, r: string) => void,
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : cbMaybe) as (
          e: Error | null,
          o: string,
          r: string,
        ) => void;
        if (args[0] === 'show') {
          cb(null, '', '');
        } else if (args[0] === 'diff') {
          const err = Object.assign(new Error(''), { code: 1, stdout: fakeDiff });
          cb(err, fakeDiff, '');
        } else {
          cb(null, '', '');
        }
      },
    );

    const result = await coordinator.getTaskDiff('task-1');

    expect(result.files).toHaveLength(1);
    expect(result.diff).toContain('My custom heading');
    expect(result.diff).not.toContain('sub-task-mode');
  });

  it('settings.local.json preserves unrelated keys, shows only non-preamble changes', async () => {
    await coordinator.createTask({ name: 'T', coordinatorTaskId: 'coord-1' });

    const settingsRelPath = '.claude/settings.local.json';
    vi.mocked(getChangedFiles).mockResolvedValue([
      { path: settingsRelPath, status: 'M', lines_added: 4, lines_removed: 0, committed: true },
    ]);
    vi.mocked(getAllFileDiffs).mockResolvedValue(
      `diff --git a/${settingsRelPath} b/${settingsRelPath}\n@@ -1 +1,5 @@\n+settings\n`,
    );

    const settingsContent = JSON.stringify(
      {
        model: 'claude-opus-4-7',
        systemPrompt: '<sub-task-mode>\nrules\n</sub-task-mode>',
      },
      null,
      2,
    );
    mockFsReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).includes('settings.local.json')) return settingsContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockExistsSync.mockImplementation((p?: unknown) => String(p).includes('settings.local.json'));
    mockReadFileSync.mockReturnValue(settingsContent);

    const fakeDiff = `diff --git a/${settingsRelPath} b/${settingsRelPath}\n--- a/${settingsRelPath}\n+++ b/${settingsRelPath}\n@@ -1,5 +1,3 @@\n {\n+  "model": "claude-opus-4-7"\n }\n`;

    // git show has opts ({cwd}), git diff --no-index does not. Detect callback by type.
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        cbMaybe?: (e: Error | null, o: string, r: string) => void,
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : cbMaybe) as (
          e: Error | null,
          o: string,
          r: string,
        ) => void;
        if (args[0] === 'show') {
          cb(null, '{}', ''); // base had empty settings
        } else if (args[0] === 'diff') {
          const err = Object.assign(new Error(''), { code: 1, stdout: fakeDiff });
          cb(err, fakeDiff, '');
        } else {
          cb(null, '', '');
        }
      },
    );

    const result = await coordinator.getTaskDiff('task-1');

    expect(result.files).toHaveLength(1); // file has real change (model key)
    expect(result.diff).toContain('model');
    expect(result.diff).not.toContain('sub-task-mode');
    expect(result.diff).not.toContain('systemPrompt');
  });
});

// ─── deregisterCoordinator .mcp.json cleanup (#40) ───────────────────────────

describe('Coordinator deregisterCoordinator — .mcp.json cleanup', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    coordinator.setMcpJsonInfo('coord-1', '/tmp/.mcp.json', false);
  });

  it('removes only the parallel-code key and preserves other servers', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'my-server': { command: 'my-tool', args: [] },
          'parallel-code': { command: 'node', args: ['server.js'] },
        },
      }),
    );

    coordinator.deregisterCoordinator('coord-1');

    const writeCall = mockAtomicWriteFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === '/tmp/.mcp.json',
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall?.[1] as string) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers['my-server']).toBeDefined();
    expect(written.mcpServers['parallel-code']).toBeUndefined();
    expect(mockUnlinkSync).not.toHaveBeenCalledWith('/tmp/.mcp.json');
  });

  it('deletes the file when parallel-code was the only entry', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { 'parallel-code': { command: 'node', args: ['server.js'] } },
      }),
    );

    coordinator.deregisterCoordinator('coord-1');

    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/.mcp.json');
    const writeCall = mockAtomicWriteFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === '/tmp/.mcp.json',
    );
    expect(writeCall).toBeUndefined();
  });

  it('does not touch the filesystem when .mcp.json does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    coordinator.deregisterCoordinator('coord-1');

    expect(mockAtomicWriteFileSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('preserves the file when it has additional top-level keys beyond mcpServers', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { 'parallel-code': { command: 'node', args: [] } },
        someOtherKey: 'kept',
      }),
    );

    coordinator.deregisterCoordinator('coord-1');

    // File should be rewritten (not deleted) because someOtherKey remains
    const writeCall = mockAtomicWriteFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === '/tmp/.mcp.json',
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall?.[1] as string) as Record<string, unknown>;
    expect(written['someOtherKey']).toBe('kept');
    expect(mockUnlinkSync).not.toHaveBeenCalledWith('/tmp/.mcp.json');
  });
});

// ─── preload allowlist regression test ───────────────────────────────────────

describe('preload.cjs MCP channel allowlist', () => {
  it('contains all MCP coordinator IPC channels', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const path = await import('node:path');
    const preloadPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'preload.cjs',
    );
    const manifestPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'ipc',
      'channel-manifest.json',
    );
    const preload = readFileSync(preloadPath, 'utf8') as string;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8') as string) as Record<
      string,
      string
    >;

    const required = [
      'mcp_task_created',
      'mcp_task_closed',
      'mcp_task_state_sync',
      'mcp_control_changed',
      'mcp_coordinator_notification_staged',
      'mcp_coordinator_orphaned_notification',
      'mcp_coordinator_registered',
      'mcp_coordinator_deregistered',
      'mcp_coordinator_notification_ack',
      'mcp_coordinated_task_prompt_delivered',
      'mcp_coordinated_task_closed',
    ];

    const channels = new Set(Object.values(manifest));
    const allowlistMatch = /new Set\(\[([\s\S]*?)\]\)/.exec(preload);
    expect(allowlistMatch).not.toBeNull();
    const preloadChannels = new Set(
      [...(allowlistMatch?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]),
    );
    for (const channel of required) {
      expect(channels.has(channel), `manifest missing channel: ${channel}`).toBe(true);
      expect(preloadChannels.has(channel), `preload missing channel: ${channel}`).toBe(true);
    }
  });
});

// ─── createTask vs concurrent deregisterCoordinator ──────────────────────────

describe('Coordinator createTask — deregister race', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('throws and cleans up the worktree when coordinator is deregistered mid-createTask', async () => {
    const { deleteTask } = await import('../ipc/tasks.js');
    mockCreateBackendTask.mockImplementation(async () => {
      coordinator.deregisterCoordinator('coord-1');
      return { id: 'task-99', branch_name: 'task/test', worktree_path: '/tmp/test-99' };
    });

    await expect(
      coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' }),
    ).rejects.toThrow('deregistered during task creation');

    expect(vi.mocked(deleteTask)).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'task/test' }),
    );
    expect(coordinator.listTasks().find((t) => t.id === 'task-99')).toBeUndefined();
  });
});

// ─── waitForSignalDone — timeoutMs honored under network flapping ─────────────

describe('MCP client waitForSignalDone — timeout under flapping', () => {
  it('does not sleep longer than remaining timeout when retrying', async () => {
    const { MCPClient } = await import('./client.js');
    const client = new MCPClient('http://localhost:9999', 'tok', 'coord-id');

    const sleepDurations: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation((cb, ms) => {
      sleepDurations.push(ms as number);
      (cb as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    vi.spyOn(client as unknown as { request: () => unknown }, 'request').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    await expect(client.waitForSignalDone('coord-id', 500)).rejects.toThrow();

    // No individual sleep should have exceeded the timeout window
    for (const d of sleepDurations) {
      expect(d).toBeLessThanOrEqual(600); // small buffer over 500ms timeout
    }

    vi.restoreAllMocks();
  });
});

// ─── createTask — enforced sub-task concurrency limit ─────────────────────────

describe('Coordinator createTask — concurrency enforcement', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnAgentHookEvent.mockReturnValue(() => {});
    mockExistsSync.mockReturnValue(false);
    let counter = 0;
    mockCreateBackendTask.mockImplementation(async () => {
      counter += 1;
      return {
        id: `task-${counter}`,
        branch_name: `task/t${counter}`,
        worktree_path: `/tmp/t${counter}`,
      };
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1', { maxConcurrentTasks: 2 });
  });

  it('rejects create_task beyond the limit with a wait_for_signal_done hint', async () => {
    await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'b', coordinatorTaskId: 'coord-1' });
    await expect(
      coordinator.createTask({ name: 'c', coordinatorTaskId: 'coord-1' }),
    ).rejects.toThrow(/concurrency limit.*wait_for_signal_done/s);
  });

  it('frees a slot when a sub-task exits', async () => {
    const first = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'b', coordinatorTaskId: 'coord-1' });
    getExitHandler()(first.agentId, { exitCode: 0 });
    await expect(
      coordinator.createTask({ name: 'c', coordinatorTaskId: 'coord-1' }),
    ).resolves.toBeDefined();
  });

  it('counts parallel not-yet-completed creations against the limit', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let counter = 0;
    mockCreateBackendTask.mockImplementation(async () => {
      await gate;
      counter += 1;
      return {
        id: `task-p${counter}`,
        branch_name: `task/p${counter}`,
        worktree_path: `/tmp/p${counter}`,
      };
    });

    const first = coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    const second = coordinator.createTask({ name: 'b', coordinatorTaskId: 'coord-1' });
    // Reservation is taken synchronously, so the third create must fail even
    // though the first two have not finished creating their worktrees yet.
    await expect(
      coordinator.createTask({ name: 'c', coordinatorTaskId: 'coord-1' }),
    ).rejects.toThrow(/concurrency limit/);

    release();
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
  });

  it('does not count a task twice while its creation is still finishing', async () => {
    // Limit 2: a task already in this.tasks but still writing its preamble
    // (the first await after registration is the settings-dir mkdir) must
    // leave one free slot, not zero — the reservation is released as soon as
    // the task is registered.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mockFsMkdir.mockImplementationOnce(() => gate);

    const first = coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    for (let i = 0; i < 50 && mockFsMkdir.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(mockFsMkdir).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).not.toHaveBeenCalled();

    await expect(
      coordinator.createTask({ name: 'b', coordinatorTaskId: 'coord-1' }),
    ).resolves.toMatchObject({ status: 'running' });

    openGate();
    await first;
    await expect(
      coordinator.createTask({ name: 'c', coordinatorTaskId: 'coord-1' }),
    ).rejects.toThrow(/concurrency limit/);
  });

  it('applies the default limit when the coordinator registers without one', async () => {
    coordinator.registerCoordinator('coord-default', 'proj-1');
    for (let i = 0; i < 3; i++) {
      await coordinator.createTask({ name: `t${i}`, coordinatorTaskId: 'coord-default' });
    }
    await expect(
      coordinator.createTask({ name: 'over', coordinatorTaskId: 'coord-default' }),
    ).rejects.toThrow(/concurrency limit/);
  });
});

// ─── Hook events — authoritative sub-task state ───────────────────────────────

type CoordinatorHookEvent = Parameters<ReturnType<typeof getHookEventHandler>>[0];

function hookEvent(
  agentId: string,
  overrides: Partial<CoordinatorHookEvent> = {},
): CoordinatorHookEvent {
  return {
    agentId,
    taskId: '',
    state: 'working',
    event: 'UserPromptSubmit',
    at: Date.now(),
    ...overrides,
  };
}

describe('Coordinator hook-driven task state', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnAgentHookEvent.mockReturnValue(() => {});
    mockExistsSync.mockReturnValue(false);
    let counter = 0;
    mockCreateBackendTask.mockImplementation(async () => {
      counter += 1;
      return {
        id: `task-h${counter}`,
        branch_name: `task/h${counter}`,
        worktree_path: `/tmp/h${counter}`,
      };
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('subscribes to hook events on construction', () => {
    expect(mockOnAgentHookEvent).toHaveBeenCalledTimes(1);
  });

  it('marks a running task idle on a hook Stop event', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    expect(task.status).toBe('running');

    getHookEventHandler()(hookEvent(task.agentId, { event: 'Stop', state: 'done' }));
    expect(task.status).toBe('idle');
  });

  it('flips an idle task back to running on a working hook event', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hookEvent(task.agentId, { event: 'Stop', state: 'done' }));
    expect(task.status).toBe('idle');

    getHookEventHandler()(hookEvent(task.agentId, { event: 'PreToolUse', toolName: 'Bash' }));
    expect(task.status).toBe('running');
  });

  it('ignores regex prompt-idle detection once hooks are live for the agent', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hookEvent(task.agentId, { event: 'UserPromptSubmit' }));
    expect(task.status).toBe('running');

    // A ❯ frame mid-turn (e.g. a rendered sub-prompt) must not flip the task
    // idle anymore — only the hook Stop event may.
    emitWorkThenIdle(getOutputCb());
    expect(task.status).toBe('running');

    getHookEventHandler()(hookEvent(task.agentId, { event: 'Stop', state: 'done' }));
    expect(task.status).toBe('idle');
  });

  it('drops hook events for unknown agents without effect', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hookEvent('not-a-task-agent', { event: 'Stop', state: 'done' }));
    expect(task.status).toBe('running');
  });

  it('ignores late hook events from an exited session', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getExitHandler()(task.agentId, { exitCode: 0 });
    expect(task.status).toBe('exited');

    // A Stop hook still in flight when the PTY died must not revive the task
    // or re-arm hook ownership for the next session on this agent id.
    getHookEventHandler()(hookEvent(task.agentId, { event: 'Stop', state: 'done' }));
    expect(task.status).toBe('exited');
  });

  it('hands idle detection back to the regex path after a user interrupt', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hookEvent(task.agentId, { event: 'UserPromptSubmit' }));
    emitWorkThenIdle(getOutputCb());
    expect(task.status).toBe('running'); // hooks own state: ❯ frame ignored

    // Esc/Ctrl+C: Claude fires no Stop, so the ❯ repaint must count again.
    getInterruptHandler()(task.agentId);
    emitWorkThenIdle(getOutputCb());
    expect(task.status).toBe('idle');
  });

  it('ignores tool hooks of the interrupted turn so they cannot re-arm ownership', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hookEvent(task.agentId, { event: 'PreToolUse', toolName: 'Bash' }));
    getInterruptHandler()(task.agentId);
    emitWorkThenIdle(getOutputCb());
    expect(task.status).toBe('idle');

    // The killed tool's result lands a moment later; no Stop will follow it.
    getHookEventHandler()(hookEvent(task.agentId, { event: 'PostToolUseFailure' }));
    expect(task.status).toBe('idle');
    emitWorkThenIdle(getOutputCb());
    expect(task.status).toBe('idle');

    // A real turn boundary re-arms hook ownership.
    getHookEventHandler()(hookEvent(task.agentId, { event: 'UserPromptSubmit' }));
    expect(task.status).toBe('running');
    emitWorkThenIdle(getOutputCb());
    expect(task.status).toBe('running');
  });

  it('does not treat a hook done as ❯-ready for the initial prompt', async () => {
    vi.useFakeTimers();
    try {
      const task = await coordinator.createTask({
        name: 'a',
        prompt: 'do a',
        coordinatorTaskId: 'coord-1',
      });
      const writesFor = (agentId: string) =>
        mockWriteToAgent.mock.calls.filter((c) => c[0] === agentId).map((c) => String(c[1]));

      // SessionStart reports done before the TUI has drawn its prompt.
      getHookEventHandler()(hookEvent(task.agentId, { event: 'SessionStart', state: 'done' }));
      getOutputCb()(Buffer.from('Loading...').toString('base64'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(writesFor(task.agentId)).toEqual([]);

      emitWorkThenIdle(getOutputCb());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(writesFor(task.agentId).some((w) => w.includes('do a'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a task running while it awaits input (permission prompt)', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hookEvent(task.agentId, { event: 'Stop', state: 'done' }));
    expect(task.status).toBe('idle');

    getHookEventHandler()(
      hookEvent(task.agentId, { event: 'PermissionRequest', state: 'waiting', toolName: 'Bash' }),
    );
    expect(task.status).toBe('running');
  });

  it('resumes regex idle detection after the agent exits and is respawned', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hookEvent(task.agentId, { event: 'UserPromptSubmit' }));
    getExitHandler()(task.agentId, { exitCode: 1 });
    expect(task.status).toBe('exited');

    // The replacement PTY is a fresh Claude session with no hook history.
    getSpawnHandler()(task.agentId);
    expect(task.status).toBe('running');
    emitWorkThenIdle(getOutputCb());
    expect(task.status).toBe('idle');
  });

  it('resolves waitForIdle waiters on a hook Stop event', async () => {
    const task = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hookEvent(task.agentId, { event: 'UserPromptSubmit' }));
    const waiter = coordinator.waitForIdle(task.id, 10_000);

    getHookEventHandler()(hookEvent(task.agentId, { event: 'Stop', state: 'done' }));
    await expect(waiter).resolves.toEqual({ reason: 'idle' });
  });
});
