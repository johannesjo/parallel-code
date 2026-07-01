import { describe, expect, it, vi } from 'vitest';
import { handleMCPToolCall } from './server.js';
import type { MCPClient } from './client.js';

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

  it('passes a valid create_task backend through to the backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work', backend: 'codex' },
    );

    expect(result).not.toHaveProperty('isError');
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ backend: 'codex' }));
  });

  it('rejects an unsupported create_task backend', async () => {
    const client = makeClient();

    const result = await handleMCPToolCall(
      { client, taskId: '', coordinatorId: 'coord-1' },
      'create_task',
      { name: 'child', prompt: 'do the work', backend: 'unknown' },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('backend must be one of') }],
    });
    expect(client.createTask).not.toHaveBeenCalled();
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
