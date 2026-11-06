import { describe, expect, it } from 'vitest';
import { isAskUserQuestionTool, mapClaudeHookPayload } from './status.js';

function payload(extra: Record<string, unknown>): Record<string, unknown> {
  return { session_id: 's', transcript_path: '/t', cwd: '/w', ...extra };
}

describe('mapClaudeHookPayload', () => {
  it('ignores non-objects and payloads without an event name', () => {
    expect(mapClaudeHookPayload(null)).toBeNull();
    expect(mapClaudeHookPayload('Stop')).toBeNull();
    expect(mapClaudeHookPayload(payload({}))).toBeNull();
  });

  it('marks a submitted prompt and tool calls as working', () => {
    expect(mapClaudeHookPayload(payload({ hook_event_name: 'UserPromptSubmit' }))).toEqual({
      state: 'working',
      event: 'UserPromptSubmit',
    });
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npm test', description: 'Run tests' },
        }),
      ),
    ).toEqual({ state: 'working', event: 'PreToolUse', toolName: 'Bash', detail: 'npm test' });
    expect(mapClaudeHookPayload(payload({ hook_event_name: 'PostToolUse' }))).toEqual({
      state: 'working',
      event: 'PostToolUse',
    });
  });

  it('marks an AskUserQuestion tool call as waiting with the first question', () => {
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Which DB?' }, { question: 'Which ORM?' }] },
        }),
      ),
    ).toEqual({
      state: 'waiting',
      event: 'PreToolUse',
      toolName: 'AskUserQuestion',
      detail: 'Which DB?',
      prompt: 'question',
    });
  });

  it('treats a plan approval prompt like a permission dialog', () => {
    expect(
      mapClaudeHookPayload(payload({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' })),
    ).toEqual({
      state: 'waiting',
      event: 'PreToolUse',
      toolName: 'ExitPlanMode',
      detail: 'Plan ready for approval',
      prompt: 'permission',
    });
  });

  it('marks permission requests and blocking notifications as waiting', () => {
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Edit',
          tool_input: { file_path: '/w/src/a.ts' },
        }),
      ),
    ).toEqual({
      state: 'waiting',
      event: 'PermissionRequest',
      toolName: 'Edit',
      detail: '/w/src/a.ts',
      prompt: 'permission',
    });
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Claude needs your permission',
        }),
      ),
    ).toEqual({
      state: 'waiting',
      event: 'Notification',
      detail: 'Claude needs your permission',
      prompt: 'permission',
    });
  });

  it('treats an idle-prompt notification as done and ignores the rest', () => {
    expect(
      mapClaudeHookPayload(
        payload({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
      ),
    ).toEqual({ state: 'done', event: 'Notification' });
    expect(
      mapClaudeHookPayload(
        payload({ hook_event_name: 'Notification', notification_type: 'auth_success' }),
      ),
    ).toBeNull();
  });

  it('marks Stop as done and keeps a single-line clipped final message', () => {
    const update = mapClaudeHookPayload(
      payload({ hook_event_name: 'Stop', last_assistant_message: '  Done.\n\nAll tests pass. ' }),
    );
    expect(update).toEqual({
      state: 'done',
      event: 'Stop',
      lastAssistantMessage: 'Done. All tests pass.',
    });

    const long = mapClaudeHookPayload(
      payload({ hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(5000) }),
    );
    expect(long?.lastAssistantMessage).toHaveLength(2000);
    expect(long?.lastAssistantMessage?.endsWith('…')).toBe(true);
  });

  it('names background shell commands still running when the turn ends', () => {
    // Recorded from Claude Code 2.1.312 after a Bash call with run_in_background.
    const shell = (id: string, description?: string) => ({
      id,
      type: 'shell',
      status: 'running',
      description,
      command: 'sleep 45; echo finished',
    });
    const stop = (tasks: unknown[]) =>
      mapClaudeHookPayload(payload({ hook_event_name: 'Stop', background_tasks: tasks }));
    expect(stop([shell('b1', 'Run delayed echo')])?.detail).toBe('background: Run delayed echo');
    expect(stop([shell('b1'), shell('b2', 'Dev server')])?.detail).toBe(
      'background: sleep 45; echo finished +1',
    );
    expect(stop([{ ...shell('b1', 'x'), status: 'completed' }])?.detail).toBeUndefined();
    expect(stop([])?.detail).toBeUndefined();
  });

  it('preserves bounded StopFailure context', () => {
    expect(
      mapClaudeHookPayload(
        payload({ hook_event_name: 'StopFailure', error: '  API unavailable\nTry later ' }),
      ),
    ).toMatchObject({ event: 'StopFailure', state: 'done', detail: 'API unavailable Try later' });
    expect(
      mapClaudeHookPayload(payload({ hook_event_name: 'StopFailure', error: 'x'.repeat(300) }))
        ?.detail,
    ).toHaveLength(200);
  });

  it('retains StopFailure error type and provider details together', () => {
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'StopFailure',
          error: 'rate_limit',
          error_details: '429 Too Many Requests',
        }),
      )?.detail,
    ).toBe('rate_limit: 429 Too Many Requests');
  });

  it('treats a fresh session as done but a compaction restart as no signal', () => {
    expect(
      mapClaudeHookPayload(payload({ hook_event_name: 'SessionStart', source: 'startup' })),
    ).toEqual({ state: 'done', event: 'SessionStart' });
    expect(
      mapClaudeHookPayload(payload({ hook_event_name: 'SessionStart', source: 'compact' })),
    ).toBeNull();
  });

  it('ignores subagent lifecycle events so a child cannot end the lead turn', () => {
    expect(mapClaudeHookPayload(payload({ hook_event_name: 'SubagentStop' }))).toBeNull();
    expect(mapClaudeHookPayload(payload({ hook_event_name: 'SubagentStart' }))).toBeNull();
  });

  it('carries the tool call id so a result can be matched to the prompt it ends', () => {
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'toolu_1',
        }),
      ),
    ).toMatchObject({ state: 'waiting', toolUseId: 'toolu_1' });
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_use_id: 'toolu_2',
        }),
      ),
    ).toMatchObject({ state: 'waiting', toolUseId: 'toolu_2' });
    expect(
      mapClaudeHookPayload(payload({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_2' })),
    ).toEqual({ state: 'working', event: 'PostToolUse', toolUseId: 'toolu_2' });
  });

  it("carries the lead's whole to-do list from a TodoWrite result", () => {
    const update = mapClaudeHookPayload(
      payload({
        hook_event_name: 'PostToolUse',
        tool_name: 'TodoWrite',
        tool_use_id: 'toolu_3',
        tool_input: {
          todos: [
            { content: 'Read the scripts', status: 'completed', activeForm: 'Reading' },
            { content: 'Check   the\ndev command', status: 'in_progress' },
            { content: 'Commit', status: 'pending' },
            { content: '', status: 'pending' },
            { status: 'pending' },
          ],
        },
      }),
    );
    expect(update?.todos).toEqual([
      { step: 'Read the scripts', status: 'completed' },
      { step: 'Check the dev command', status: 'in_progress' },
      { step: 'Commit', status: 'pending' },
    ]);
  });

  it('caps a long to-do list and its step text', () => {
    const todos = Array.from({ length: 40 }, (_, i) => ({
      content: `${i} ${'x'.repeat(300)}`,
      status: 'pending',
    }));
    const update = mapClaudeHookPayload(
      payload({ hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos } }),
    );
    expect(update?.todos).toHaveLength(30);
    expect(update?.todos?.[0].step).toHaveLength(200);
  });

  it("ignores a sub-agent's to-do list so it cannot replace the lead's plan", () => {
    const update = mapClaudeHookPayload(
      payload({
        hook_event_name: 'PostToolUse',
        tool_name: 'TodoWrite',
        agent_id: 'sub-1',
        tool_input: { todos: [{ content: 'Sub step', status: 'pending' }] },
      }),
    );
    expect(update).toEqual({ state: 'working', event: 'PostToolUse' });
  });

  it("ignores a sub-agent's failed command so it is not shown under the lead's step", () => {
    const update = mapClaudeHookPayload(
      payload({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        agent_id: 'sub-1',
        tool_input: { command: 'npm test' },
      }),
    );
    expect(update).toEqual({ state: 'working', event: 'PostToolUseFailure' });
  });

  it('names the command of a failed shell call, but not of other failed tools', () => {
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'Bash',
          tool_input: { command: 'npm run dev' },
        }),
      ),
    ).toEqual({ state: 'working', event: 'PostToolUseFailure', failedCommand: 'npm run dev' });
    expect(
      mapClaudeHookPayload(
        payload({
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'Read',
          tool_input: { file_path: '/w/a.ts' },
        }),
      ),
    ).toEqual({ state: 'working', event: 'PostToolUseFailure' });
  });
});

describe('isAskUserQuestionTool', () => {
  it('matches vendor spellings and rejects other tools', () => {
    expect(isAskUserQuestionTool('AskUserQuestion')).toBe(true);
    expect(isAskUserQuestionTool('ask_user_question')).toBe(true);
    expect(isAskUserQuestionTool('request_user_input')).toBe(true);
    expect(isAskUserQuestionTool('Bash')).toBe(false);
    expect(isAskUserQuestionTool(undefined)).toBe(false);
  });
});
