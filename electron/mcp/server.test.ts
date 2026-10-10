import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleMCPToolCall, parseArgs, readTokenFile } from './server.js';
import { MCPClient } from './client.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';
import { selectTools } from './mcp-tool-list.js';
import { buildSubTaskPreamble } from './sub-task-preamble.js';
import { REVIEW_SUB_TASK_MODE_PREAMBLE, SUB_TASK_MODE_PREAMBLE } from './preamble.js';
import type { CompletionReport } from '../shared/completion-report.js';

function makeClient(): MCPClient {
  return {
    createTask: vi.fn().mockResolvedValue({
      id: 'task-1',
      name: 'child',
      branchName: 'task/child',
      worktreePath: '/tmp/child',
      projectId: 'proj-1',
      agentId: 'agent-1',
      status: 'running',
      coordinatorTaskId: 'coord-1',
      exitCode: null,
    }),
    sendPrompt: vi.fn().mockResolvedValue({ queued: false }),
  } as unknown as MCPClient;
}

describe('MCP server tool handling', () => {
  it('rejects create_task without a prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('rejects create_task with a blank prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: '  ' },
    );

    expect(result).toMatchObject({ isError: true });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('rejects create_task with a non-string prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 123 },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('passes create_task prompt through to the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work' },
    );

    expect(result).not.toHaveProperty('isError');
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'child',
        prompt: 'do the work',
        coordinatorTaskId: 'coord-1',
      }),
    );
  });

  it('passes a valid create_task baseBranch through to the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work', baseBranch: 'feature/base' },
    );

    expect(result).not.toHaveProperty('isError');
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'feature/base',
      }),
    );
  });

  it('rejects an invalid create_task baseBranch before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work', baseBranch: '../main' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('baseBranch') }],
    });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('returns sent text when send_prompt writes immediately', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      content: [{ text: 'Prompt sent successfully.' }],
    });
    expect(client.sendPrompt).toHaveBeenCalledWith('task-1', 'continue');
  });

  it('rejects send_prompt without a taskId before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: taskId must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt with a blank taskId before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: '  ', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: taskId must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt with a non-string taskId before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 123, prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: taskId must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt without a prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt with a blank prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: '  ' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects send_prompt with a non-string prompt before calling the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: 123 },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: prompt must be a non-empty string' }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it('returns queued text when send_prompt is parked behind another prompt', async () => {
    const client = makeClient();
    vi.mocked(client.sendPrompt).mockResolvedValueOnce({ queued: true });

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining('Prompt queued') }],
    });
  });

  it('returns backend send_prompt errors as MCP errors', async () => {
    const client = makeClient();
    vi.mocked(client.sendPrompt).mockRejectedValueOnce(
      new Error('Prompt exceeds 65536 byte limit'),
    );

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'send_prompt',
      { taskId: 'task-1', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: Prompt exceeds 65536 byte limit' }],
    });
  });

  it('returns backend create_task errors as MCP errors', async () => {
    const client = makeClient();
    vi.mocked(client.createTask).mockRejectedValueOnce(
      new Error('coordinator coord-1 is not registered'),
    );

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: coordinator coord-1 is not registered' }],
    });
  });

  it('rejects send_prompt from sub-task scoped MCP clients', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: 'task-1', coordinatorId: '' },
      'send_prompt',
      { taskId: 'task-2', prompt: 'continue' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('not available to sub-tasks') }],
    });
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });
});

describe('structured MCP completion contracts', () => {
  const report: CompletionReport = {
    summary: 'Updated completion contracts.',
    verification: {
      checks: [{ name: 'Unit tests', command: 'npm run test:unit', result: 'passed' }],
    },
    artifacts: [{ path: 'electron/mcp/server.ts', label: 'Tool dispatcher' }],
    unresolvedIssues: ['Native smoke check unavailable.'],
  };
  const completion = {
    id: 'completion-1',
    completedAt: '2026-09-26T12:00:00.000Z',
    reviewRevision: 1,
    sourceCommit: 'abc123',
    snapshotState: 'clean',
    result: report,
  };
  const task = {
    id: 'child',
    name: 'Child',
    branchName: 'task/child',
    status: 'idle',
    coordinatorTaskId: 'parent',
    worktreePath: '/tmp/child',
    projectId: 'project',
    agentId: 'agent',
    exitCode: null,
    integrationPolicy: 'review',
    reviewRevision: 2,
    completion,
    activityEvidence: {
      agentId: 'agent',
      source: 'hook',
      activity: 'turn_finished',
      event: 'Stop',
      freshness: 'current',
    },
  };
  const landing = {
    mainBranch: 'task/parent',
    linesAdded: 3,
    linesRemoved: 1,
    landingState: 'landed_pending_review',
    landedMetadata: {
      taskId: 'child',
      taskName: 'Child',
      coordinatorTaskId: 'parent',
      targetBranch: 'task/parent',
      landedCommit: 'abc123',
      landedAt: completion.completedAt,
      landedOrder: 1,
      verification: report.verification,
    },
  };
  const fixtures = [
    { name: 'get_task_status', method: 'getTaskStatus', result: task },
    { name: 'list_tasks', method: 'listTasks', result: [task] },
    { name: 'list_tasks', method: 'listTasks', result: [] },
    { name: 'signal_done', method: 'signalDone', result: { ok: true, completion } },
    {
      name: 'signal_done',
      method: 'signalDone',
      result: {
        ok: true,
        completion: {
          ...completion,
          result: undefined,
          sourceCommit: undefined,
          snapshotState: 'unknown',
        },
      },
    },
    { name: 'land_self', method: 'landSelf', result: landing },
    {
      name: 'wait_for_signal_done',
      method: 'waitForSignalDone',
      result: {
        taskId: 'child',
        name: 'Child',
        status: 'idle',
        signalDoneAt: completion.completedAt,
        completion,
        remaining: 1,
      },
    },
    { name: 'wait_for_signal_done', method: 'waitForSignalDone', result: { remaining: 0 } },
    {
      name: 'wait_for_signal_done',
      method: 'waitForSignalDone',
      result: { remaining: 1, timedOut: true },
    },
  ];
  for (const session of [false, true]) {
    it.each(fixtures)(
      `validates $name output for ${session ? 'session' : 'legacy'} dispatch`,
      async ({ name, method, result }) => {
        const child = name === 'signal_done' || name === 'land_self';
        const capabilities = {
          profile:
            name === 'signal_done'
              ? ('child-review' as const)
              : child
                ? ('child-automatic' as const)
                : ('ordinary' as const),
          canCreate: false,
          peers: false,
        };
        const context = {
          client: {
            [method]: vi.fn().mockResolvedValue(result),
            callSessionTool: vi.fn().mockResolvedValue(result),
          } as unknown as MCPClient,
          taskId: child ? 'child' : session ? 'parent' : '',
          coordinatorId: !child && !session ? 'parent' : '',
          ...(session && { sessionCapabilities: capabilities }),
        };
        const output = await handleMCPToolCall(
          context,
          name,
          child ? { result: report } : { taskId: 'child' },
        );
        const tool = selectTools(
          context.taskId,
          context.coordinatorId,
          false,
          context.sessionCapabilities,
        ).find((tool) => tool.name === name);
        const validate = new AjvJsonSchemaValidator().getValidator(
          tool?.outputSchema as JsonSchemaType,
        );
        expect(output).not.toHaveProperty('isError');
        expect(
          validate('structuredContent' in output ? output.structuredContent : undefined),
        ).toMatchObject({ valid: true });
        expect(output.content).toEqual([
          {
            type: 'text',
            text:
              name === 'signal_done' && !session
                ? 'Done signal sent. The coordinator has been notified.'
                : JSON.stringify(result, null, 2),
          },
        ]);
        if (name === 'list_tasks')
          expect(output).toHaveProperty('structuredContent', { tasks: result });
        if (name === 'signal_done') {
          if (session)
            expect(context.client.callSessionTool).toHaveBeenCalledWith('signal_done', {
              result: report,
            });
          else expect(context.client.signalDone).toHaveBeenCalledWith('child', { result: report });
        }
      },
    );
  }

  it.each([false, true])(
    'rejects malformed reports before %s transport dispatch',
    async (session) => {
      const client = {
        signalDone: vi.fn(),
        callSessionTool: vi.fn(),
      } as unknown as MCPClient;
      const context = {
        client,
        taskId: 'child',
        coordinatorId: '',
        ...(session && {
          sessionCapabilities: { profile: 'child-review' as const, canCreate: false, peers: false },
        }),
      };
      for (const input of [
        { result: { summary: '' } },
        { result: { summary: 'x', artifacts: [{ path: '../outside' }] } },
        { result: { summary: 'x'.repeat(4097) } },
      ]) {
        const output = await handleMCPToolCall(context, 'signal_done', input);
        expect(output).toMatchObject({ isError: true });
        expect(output).not.toHaveProperty('structuredContent');
      }
      expect(client.signalDone).not.toHaveBeenCalled();
      expect(client.callSessionTool).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'treats rejected done results as errors for %s transport',
    async (session) => {
      const context = {
        client: {
          signalDone: vi.fn().mockResolvedValue({ ok: false }),
          callSessionTool: vi.fn().mockResolvedValue({ ok: false }),
        } as unknown as MCPClient,
        taskId: 'child',
        coordinatorId: '',
        ...(session && {
          sessionCapabilities: { profile: 'child-review' as const, canCreate: false, peers: false },
        }),
      };
      const output = await handleMCPToolCall(context, 'signal_done', {});
      expect(output).toMatchObject({
        isError: true,
        content: [{ text: 'Error: Completion signal was rejected.' }],
      });
      expect(output).not.toHaveProperty('structuredContent');
      if (session) expect(context.client.callSessionTool).toHaveBeenCalledWith('signal_done', {});
      else expect(context.client.signalDone).toHaveBeenCalledWith('child', {});
    },
  );

  it('sends the parsed report with task ownership credentials and returns the capture', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, completion }), { status: 200 }));
    try {
      const client = new MCPClient('http://localhost:7777', 'token', undefined, 'done-token');
      await expect(
        client.signalDone('child', {
          result: report,
        }),
      ).resolves.toEqual({ ok: true, completion });
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:7777/api/tasks/child/done', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          'X-Done-Token': 'done-token',
        },
        body: JSON.stringify({ result: report }),
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([false, true])(
    'omits structured data on backend failures for %s transport',
    async (session) => {
      for (const { name, method } of fixtures) {
        const child = name === 'signal_done' || name === 'land_self';
        const context = {
          client: {
            [method]: vi.fn().mockRejectedValue(new Error('Backend unavailable.')),
            callSessionTool: vi.fn().mockRejectedValue(new Error('Backend unavailable.')),
          } as unknown as MCPClient,
          taskId: child ? 'child' : session ? 'parent' : '',
          coordinatorId: !child && !session ? 'parent' : '',
          ...(session && {
            sessionCapabilities: {
              profile: child ? ('child-automatic' as const) : ('ordinary' as const),
              canCreate: false,
              peers: false,
            },
          }),
        };
        const output = await handleMCPToolCall(
          context,
          name,
          name === 'signal_done' ? { result: { summary: 'done' } } : { taskId: 'child' },
        );
        expect(output).toMatchObject({
          isError: true,
          content: [{ text: 'Error: Backend unavailable.' }],
        });
        expect(output).not.toHaveProperty('structuredContent');
      }
    },
  );

  it('asks for truthful concise reports in both runtime guidance generators', () => {
    for (const guidance of [
      SUB_TASK_MODE_PREAMBLE,
      REVIEW_SUB_TASK_MODE_PREAMBLE,
      buildSubTaskPreamble(),
      buildSubTaskPreamble('npm test', 'review'),
    ]) {
      expect(guidance).toContain('concise');
      expect(guidance).toContain('checks actually run');
      expect(guidance).toContain('repository-relative artifact paths');
      expect(guidance).toContain('unresolved issues');
    }
  });
});

describe('mind map tools', () => {
  it('returns an actionable operation error for the reported reasoning payload without blaming valid IDs', async () => {
    const client = { updateReasoning: vi.fn() } as unknown as MCPClient;
    const result = await handleMCPToolCall(
      { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true },
      'reasoning_update',
      {
        runId: null,
        newRunId: 'architecture-shallow-2026-09-15',
        expectedRevision: 0,
        activeId: 'repo',
        operations: [
          {
            type: 'insert_node',
            node: {
              id: 'repo',
              title: 'Repository architecture',
              kind: 'claim',
              status: 'accepted',
              summary: 'A content-only repository.',
            },
          },
        ],
      },
    );
    expect(result).toMatchObject({
      isError: true,
      content: [
        { text: expect.stringContaining('operations[0].type. Use one of: insert, update') },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('Invalid graph ID');
    expect(client.updateReasoning).not.toHaveBeenCalled();
  });
  it('uses the session task, never a caller-supplied task ID', async () => {
    const client = {
      readMindMap: vi.fn().mockResolvedValue({ revision: 2 }),
      updateMindMap: vi.fn().mockResolvedValue({ revision: 3 }),
    } as unknown as MCPClient;
    const context = { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true };
    expect(
      await handleMCPToolCall(context, 'mindmap_read', { taskId: 'other-task' }),
    ).not.toHaveProperty('isError');
    expect(client.readMindMap).toHaveBeenCalledWith('own-task');
    const update = {
      expectedRevision: 2,
      operations: [{ type: 'update', id: 'root', changes: { title: 'New title' } }],
    };
    expect(await handleMCPToolCall(context, 'mindmap_update', update)).not.toHaveProperty(
      'isError',
    );
    expect(client.updateMindMap).toHaveBeenCalledWith('own-task', update);
    expect(await handleMCPToolCall(context, 'create_task', { prompt: 'No' })).toHaveProperty(
      'isError',
      true,
    );
  });
  it('opens a canvas view for the session task and rejects unknown views before transport', async () => {
    const client = {
      openCanvas: vi.fn().mockResolvedValue({ ok: true, view: 'reasoning' }),
    } as unknown as MCPClient;
    const context = { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true };
    expect(
      await handleMCPToolCall(context, 'canvas_open', { view: 'reasoning', taskId: 'other' }),
    ).not.toHaveProperty('isError');
    expect(client.openCanvas).toHaveBeenCalledWith('own-task', 'reasoning');
    expect(await handleMCPToolCall(context, 'canvas_open', { view: 'browser' })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('mindmap, reasoning') }],
    });
    expect(client.openCanvas).toHaveBeenCalledTimes(1);
  });
  it('publishes a tour for the session task and rejects a malformed one before transport', async () => {
    const client = {
      publishTour: vi.fn().mockResolvedValue({ ok: true, subject: 'the retry bug' }),
    } as unknown as MCPClient;
    const card = { label: 'KEY DECISION', title: 'One idea', body: 'Body text.' };
    const tour = { subject: 'the retry bug', gist: card, cards: [card], context: 'The facts.' };
    const context = { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true };
    expect(
      await handleMCPToolCall(context, 'tour_publish', { ...tour, taskId: 'other' }),
    ).not.toHaveProperty('isError');
    expect(client.publishTour).toHaveBeenCalledWith('own-task', tour);
    expect(await handleMCPToolCall(context, 'tour_publish', { ...tour, cards: [] })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('cards must be an array') }],
    });
    expect(client.publishTour).toHaveBeenCalledTimes(1);
  });

  it('publishes a confidence rating for the session task and rejects a malformed one before transport', async () => {
    const client = {
      publishConfidence: vi.fn().mockResolvedValue({ ok: true, scores: 1 }),
    } as unknown as MCPClient;
    const rating = {
      scores: [{ label: 'Correct', score: 80.4, why: 'Happy path tested.' }],
      findings: [{ kind: 'gap', text: 'No dedupe yet.', file: 'src/a.ts' }],
      source: 'review skill',
    };
    const context = { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true };
    expect(
      await handleMCPToolCall(context, 'confidence_publish', { ...rating, taskId: 'other' }),
    ).not.toHaveProperty('isError');
    expect(client.publishConfidence).toHaveBeenCalledWith('own-task', {
      ...rating,
      scores: [{ label: 'Correct', score: 80, why: 'Happy path tested.' }],
    });
    expect(
      await handleMCPToolCall(context, 'confidence_publish', { ...rating, scores: [] }),
    ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('scores') }] });
    expect(client.publishConfidence).toHaveBeenCalledTimes(1);
  });

  it('publishes a GitHub list for the session task and rejects a malformed one before transport', async () => {
    const client = {
      publishGitHubList: vi.fn().mockResolvedValue({ ok: true, name: 'This week' }),
    } as unknown as MCPClient;
    const item = { url: 'https://github.com/o/r/issues/2', title: 'Two', reason: 'Data loss' };
    const list = { name: 'This week', groups: [{ name: 'Sync', items: [item] }] };
    const context = { client, taskId: 'gh-agent-p1', coordinatorId: '', canvasOnly: true };
    expect(await handleMCPToolCall(context, 'github_list_publish', list)).not.toHaveProperty(
      'isError',
    );
    expect(client.publishGitHubList).toHaveBeenCalledWith('gh-agent-p1', list);
    expect(
      await handleMCPToolCall(context, 'github_list_publish', { ...list, groups: [] }),
    ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('groups') }] });
    expect(client.publishGitHubList).toHaveBeenCalledTimes(1);
  });

  it('refuses github_list_publish from tasks other than the GitHub page agent', async () => {
    const client = { publishGitHubList: vi.fn() } as unknown as MCPClient;
    const result = await handleMCPToolCall(
      { client, taskId: 'own-task', coordinatorId: '', canvasOnly: true },
      'github_list_publish',
      {},
    );
    expect(result).toMatchObject({ isError: true });
    expect(client.publishGitHubList).not.toHaveBeenCalled();
  });

  it('refuses tour_publish without a task-scoped session', async () => {
    const client = { publishTour: vi.fn() } as unknown as MCPClient;
    const card = { label: 'KEY DECISION', title: 'One idea', body: 'Body text.' };
    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: '' },
      'tour_publish',
      {
        subject: 'the retry bug',
        gist: card,
        cards: [card],
      },
    );
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('task-scoped MCP session') }],
    });
    expect(client.publishTour).not.toHaveBeenCalled();
  });

  it('rejects invalid operations before transport and exposes conflict failures', async () => {
    const client = {
      updateMindMap: vi.fn().mockRejectedValue(new Error('Read it again before editing.')),
    } as unknown as MCPClient;
    const context = { client, taskId: 'own-task', coordinatorId: '' };
    expect(
      await handleMCPToolCall(context, 'mindmap_update', {
        expectedRevision: 0,
        operations: [{ type: 'oops', id: 'root' }],
      }),
    ).toHaveProperty('isError', true);
    expect(client.updateMindMap).not.toHaveBeenCalled();
    expect(
      await handleMCPToolCall(context, 'mindmap_update', {
        expectedRevision: 0,
        operations: [{ type: 'update', id: 'root', changes: { title: 'Mine' } }],
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('Read it again') }],
    });
  });
});

describe('token file launches', () => {
  it('reads the session token from the 0600 config instead of argv or env', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-token-file-'));
    const file = path.join(directory, 'config.json');
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({
          mcpServers: { 'parallel-code': { env: { PARALLEL_CODE_MCP_TOKEN: 'secret' } } },
        }),
      );
      expect(parseArgs(['--url', 'http://x', '--token-file', file, '--canvas-only'])).toMatchObject(
        {
          url: 'http://x',
          tokenFile: file,
          canvasOnly: true,
        },
      );
      expect(readTokenFile(file)).toBe('secret');
      fs.writeFileSync(file, '{"mcpServers":{}}');
      expect(readTokenFile(file)).toBe('');
      expect(readTokenFile(path.join(directory, 'missing.json'))).toBe('');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports why a token file yielded no token before the generic usage error', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-token-file-'));
    const file = path.join(directory, 'config.json');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(readTokenFile(path.join(directory, 'missing.json'))).toBe('');
      expect(error).toHaveBeenLastCalledWith(
        expect.stringContaining('token file'),
        expect.objectContaining({ code: 'ENOENT' }),
      );
      fs.writeFileSync(file, '{not json');
      expect(readTokenFile(file)).toBe('');
      expect(error).toHaveBeenLastCalledWith(
        expect.stringContaining('token file'),
        expect.any(SyntaxError),
      );
      fs.writeFileSync(file, '{"mcpServers":{}}');
      expect(readTokenFile(file)).toBe('');
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('no PARALLEL_CODE_MCP_TOKEN'));
    } finally {
      error.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('capability-bound sessions', () => {
  const capabilities = { profile: 'ordinary' as const, canCreate: true, peers: true };

  it('parses the session profile and additional launch flags without coordinator authority', () => {
    expect(
      parseArgs([
        '--peer-tools',
        '--url',
        'http://localhost:7777',
        '--task-id',
        'parent',
        '--session-profile',
        'ordinary',
        '--allow-create',
      ]),
    ).toMatchObject({
      taskId: 'parent',
      coordinatorId: '',
      canvasOnly: false,
      sessionCapabilities: capabilities,
    });
    for (const args of [
      ['--session-profile', 'unknown'],
      ['--session-profile', 'ordinary'],
      ['--task-id', 'parent', '--session-profile', 'ordinary', '--canvas-only'],
      ['--task-id', 'parent', '--session-profile', 'ordinary', '--coordinator-id', 'other'],
      ['--allow-create'],
    ])
      expect(() => parseArgs(args)).toThrow();
  });

  it('routes ordinary creation through session authority without a coordinator header', async () => {
    const client = makeClient();
    client.callSessionTool = vi.fn().mockResolvedValue({ id: 'child' });
    const params = {
      name: 'Child',
      prompt: 'Fix it',
      requestId: 'request-1',
      expectedBranch: 'task/parent',
      expectedHeadSha: 'abc',
      useLastCommit: true,
    };
    const result = await handleMCPToolCall(
      { client, taskId: 'parent', coordinatorId: '', sessionCapabilities: capabilities },
      'create_task',
      params,
    );
    expect(result).not.toHaveProperty('isError');
    expect(client.callSessionTool).toHaveBeenCalledWith('create_task', params);
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('blocks hidden management and child creation even when invoked directly', async () => {
    const client = makeClient();
    client.callSessionTool = vi.fn();
    for (const name of ['merge_task', 'close_task', 'review_and_merge_task', 'land_self']) {
      expect(
        await handleMCPToolCall(
          { client, taskId: 'parent', coordinatorId: '', sessionCapabilities: capabilities },
          name,
          {},
        ),
      ).toMatchObject({ isError: true });
    }
    for (const name of ['create_task', 'land_self', 'list_tasks']) {
      expect(
        await handleMCPToolCall(
          {
            client,
            taskId: 'child',
            coordinatorId: '',
            sessionCapabilities: { ...capabilities, profile: 'child-review' },
          },
          name,
          {},
        ),
      ).toMatchObject({ isError: true });
    }
    expect(client.callSessionTool).not.toHaveBeenCalled();
  });

  it('normalizes bounded waits and rejects invalid timeout values', async () => {
    const client = makeClient();
    client.callSessionTool = vi.fn().mockResolvedValue({ remaining: 0 });
    const context = {
      client,
      taskId: 'parent',
      coordinatorId: '',
      sessionCapabilities: capabilities,
    };
    await handleMCPToolCall(context, 'wait_for_signal_done', {});
    expect(client.callSessionTool).toHaveBeenLastCalledWith('wait_for_signal_done', {
      timeoutMs: 30000,
    });
    await handleMCPToolCall(context, 'wait_for_agent_prompt', {
      deliveryId: 'delivery',
      lastObservedState: 'waiting',
      timeoutMs: 90000,
    });
    expect(client.callSessionTool).toHaveBeenLastCalledWith('wait_for_agent_prompt', {
      deliveryId: 'delivery',
      lastObservedState: 'waiting',
      timeoutMs: 60000,
    });
    for (const timeoutMs of [0, -1, NaN, Infinity, '30000'])
      expect(await handleMCPToolCall(context, 'wait_for_signal_done', { timeoutMs })).toMatchObject(
        { isError: true },
      );
  });

  it('retains canvas validation instead of forwarding arbitrary graph payloads', async () => {
    const client = makeClient();
    client.callSessionTool = vi.fn();
    const result = await handleMCPToolCall(
      { client, taskId: 'parent', coordinatorId: '', sessionCapabilities: capabilities },
      'mindmap_update',
      { operations: 'invalid' },
    );
    expect(result).toMatchObject({ isError: true });
    expect(client.callSessionTool).not.toHaveBeenCalled();
  });
});

it('sends scoped tool requests with the bearer credential and no coordinator override', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ state: 'waiting' }), { status: 200 }));
  try {
    const client = new MCPClient('http://localhost:7777', 'session-token');
    await expect(
      client.callSessionTool('send_agent_prompt', {
        agentId: 'recipient',
        sessionInstanceId: 'instance',
        prompt: 'Please review',
        requestId: 'request',
      }),
    ).resolves.toEqual({ state: 'waiting' });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:7777/api/session/tools', {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'send_agent_prompt',
        params: {
          agentId: 'recipient',
          sessionInstanceId: 'instance',
          prompt: 'Please review',
          requestId: 'request',
        },
      }),
    });
  } finally {
    fetchMock.mockRestore();
  }
});

describe('legacy dispatch hardening', () => {
  const coordinator = { taskId: '', coordinatorId: 'coord-1' };

  it('treats omitted arguments as an empty object and rejects non-object arguments', async () => {
    const client = makeClient();
    client.listTasks = vi.fn().mockResolvedValue([]);
    expect(
      await handleMCPToolCall({ client, ...coordinator }, 'get_task_status', undefined),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'Error: taskId must be a non-empty string' }],
    });
    expect(
      await handleMCPToolCall({ client, ...coordinator }, 'list_tasks', undefined),
    ).not.toHaveProperty('isError');
    expect(await handleMCPToolCall({ client, ...coordinator }, 'list_tasks', [])).toMatchObject({
      isError: true,
    });
  });

  it.each(['get_task_status', 'wait_for_idle', 'get_task_diff', 'get_task_output', 'close_task'])(
    'rejects %s without a taskId before calling the backend',
    async (name) => {
      const client = makeClient();
      const result = await handleMCPToolCall({ client, ...coordinator }, name, { taskId: 7 });
      expect(result).toMatchObject({ isError: true });
    },
  );

  it('defaults and caps legacy wait timeouts below the undici headers timeout', async () => {
    const client = makeClient();
    client.waitForIdle = vi.fn().mockResolvedValue({ status: 'idle', reason: 'x' });
    client.waitForSignalDone = vi.fn().mockResolvedValue({ remaining: 0 });
    await handleMCPToolCall({ client, ...coordinator }, 'wait_for_idle', { taskId: 't' });
    expect(client.waitForIdle).toHaveBeenLastCalledWith('t', 240_000);
    await handleMCPToolCall({ client, ...coordinator }, 'wait_for_idle', {
      taskId: 't',
      timeoutMs: 900_000,
    });
    expect(client.waitForIdle).toHaveBeenLastCalledWith('t', 240_000);
    await handleMCPToolCall({ client, ...coordinator }, 'wait_for_signal_done', {});
    expect(client.waitForSignalDone).toHaveBeenLastCalledWith('coord-1', 240_000);
    for (const timeoutMs of [0, -5, NaN, Infinity, '10'])
      expect(
        await handleMCPToolCall({ client, ...coordinator }, 'wait_for_signal_done', { timeoutMs }),
      ).toMatchObject({ isError: true });
  });

  it('enforces the advertised tool set when both ids are configured', async () => {
    const client = makeClient();
    client.signalDone = vi.fn();
    const result = await handleMCPToolCall(
      { client, taskId: 'task-1', coordinatorId: 'coord-1' },
      'signal_done',
      { result: { summary: 'done' } },
    );
    expect(result).toMatchObject({ isError: true });
    expect(client.signalDone).not.toHaveBeenCalled();
  });

  it('keeps content valid for malformed backend results', async () => {
    const client = makeClient();
    client.listTasks = vi.fn().mockResolvedValue({ not: 'an array' });
    client.getTaskStatus = vi.fn().mockResolvedValue(undefined);
    client.getTaskOutput = vi.fn().mockResolvedValue({});
    expect(await handleMCPToolCall({ client, ...coordinator }, 'list_tasks', {})).toMatchObject({
      isError: true,
    });
    expect(
      await handleMCPToolCall({ client, ...coordinator }, 'get_task_status', { taskId: 't' }),
    ).toMatchObject({ isError: true });
    expect(
      await handleMCPToolCall({ client, ...coordinator }, 'get_task_output', { taskId: 't' }),
    ).toEqual({ content: [{ type: 'text', text: '' }] });
  });
});
