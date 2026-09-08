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
