import { describe, expect, it } from 'vitest';
import { selectTools, SUBTASK_TOOLS, COORDINATOR_TOOLS, type ToolDef } from './mcp-tool-list.js';

describe('selectTools — role-based tool list', () => {
  it('sub-task (taskId set, no coordinatorId) gets only sub-task tools', () => {
    const tools = selectTools('task-abc', '');
    expect(tools).toEqual(SUBTASK_TOOLS);
    expect(tools.map((t: ToolDef) => t.name)).toStrictEqual(['land_self', 'signal_done']);
  });

  it('coordinator (coordinatorId set, no taskId) gets coordinator tools', () => {
    const tools = selectTools('', 'coordinator-xyz');
    expect(tools).toEqual(COORDINATOR_TOOLS);
  });

  it('coordinator tools do NOT include signal_done', () => {
    const tools = selectTools('', 'coordinator-xyz');
    expect(tools.map((t: ToolDef) => t.name)).not.toContain('signal_done');
  });

  it('coordinator tools include the expected lifecycle tools', () => {
    const names = selectTools('', 'coordinator-xyz').map((t: ToolDef) => t.name);
    for (const expected of [
      'create_task',
      'list_tasks',
      'get_task_status',
      'send_prompt',
      'wait_for_idle',
      'wait_for_signal_done',
      'get_task_diff',
      'get_task_output',
      'merge_task',
      'close_task',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('plain agent (neither taskId nor coordinatorId) gets coordinator tools', () => {
    const tools = selectTools('', '');
    expect(tools).toEqual(COORDINATOR_TOOLS);
  });

  it('coordinator tool descriptions warn against resending assignments from startup placeholders', () => {
    const byName = new Map(COORDINATOR_TOOLS.map((tool) => [tool.name, tool.description]));
    expect(byName.get('create_task')).toContain('startup/default placeholder');
    expect(byName.get('send_prompt')).toContain('Do not resend the full original assignment');
    expect(byName.get('get_task_output')).toContain('Improve documentation in @filename');
  });

  it('create_task documents the coordinator branch as the default base branch', () => {
    const createTask = COORDINATOR_TOOLS.find((tool) => tool.name === 'create_task');
    const properties = createTask?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    expect(properties?.baseBranch?.description).toContain(
      'Defaults to the coordinator task branch',
    );
  });

  it('create_task requires an initial prompt', () => {
    const createTask = COORDINATOR_TOOLS.find((tool) => tool.name === 'create_task');
    expect(createTask?.inputSchema.required).toContain('prompt');
  });

  it('create_task declares prompt as a string input', () => {
    const createTask = COORDINATOR_TOOLS.find((tool) => tool.name === 'create_task');
    const properties = createTask?.inputSchema.properties as
      | Record<string, { type?: string }>
      | undefined;
    expect(properties?.prompt?.type).toBe('string');
  });

  it('create_task exposes the supported agent backends', () => {
    const createTask = COORDINATOR_TOOLS.find((tool) => tool.name === 'create_task');
    const properties = createTask?.inputSchema.properties as
      | Record<string, { type?: string; enum?: string[] }>
      | undefined;
    expect(properties?.backend).toEqual({
      type: 'string',
      enum: ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity'],
      description: expect.stringContaining('Defaults to the coordinator backend'),
    });
  });

  it('send_prompt requires a prompt', () => {
    const sendPrompt = COORDINATOR_TOOLS.find((tool) => tool.name === 'send_prompt');
    expect(sendPrompt?.inputSchema.required).toContain('prompt');
  });

  it('send_prompt requires a taskId', () => {
    const sendPrompt = COORDINATOR_TOOLS.find((tool) => tool.name === 'send_prompt');
    expect(sendPrompt?.inputSchema.required).toContain('taskId');
  });

  it('send_prompt declares taskId and prompt as string inputs', () => {
    const sendPrompt = COORDINATOR_TOOLS.find((tool) => tool.name === 'send_prompt');
    const properties = sendPrompt?.inputSchema.properties as
      | Record<string, { type?: string }>
      | undefined;
    expect(properties?.taskId?.type).toBe('string');
    expect(properties?.prompt?.type).toBe('string');
  });

  it('sub-task tools do NOT include any coordinator lifecycle tools', () => {
    const names = selectTools('task-abc', '').map((t: ToolDef) => t.name);
    for (const forbidden of ['create_task', 'merge_task', 'close_task', 'wait_for_signal_done']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
