import { describe, expect, it } from 'vitest';
import {
  APPROVED_THEN_INTERRUPTED,
  DECLINED_THEN_COMPLETED,
  PATCH_APPROVED,
  QUESTION_ANSWERED,
  TOOL_TURN,
} from './codex-recordings.js';
import { mapCodexHookPayload } from './codex-status.js';
import {
  activityEvidenceFromHook,
  transitionAgentHookStatus,
  type ReducedAgentHookStatus,
} from './status.js';

/** The status after each recorded payload, as `state event [detail]`, or `ignored`. */
function replay(recording: readonly unknown[]): { timeline: string[]; activity: string } {
  let status: ReducedAgentHookStatus | undefined;
  const timeline = recording.map((payload, at) => {
    const update = mapCodexHookPayload(payload);
    if (!update) return 'ignored';
    status = transitionAgentHookStatus(status, { ...update, at });
    return [status.state, status.event, status.detail].filter(Boolean).join(' ');
  });
  if (!status) throw new Error('the recording produced no status');
  return { timeline, activity: activityEvidenceFromHook('agent-1', 'launch-1', status).activity };
}

describe('recorded Codex sessions', () => {
  it('follows a turn that runs a command and finishes', () => {
    expect(replay(TOOL_TURN)).toEqual({
      timeline: [
        'ignored',
        'working UserPromptSubmit',
        'working PreToolUse echo hello-from-tool',
        'working PostToolUse',
        'done Stop',
      ],
      activity: 'turn_finished',
    });
  });

  it('waits on an approval, resumes once the command ran, and ends on Esc', () => {
    expect(replay(APPROVED_THEN_INTERRUPTED)).toEqual({
      timeline: [
        'ignored',
        'working UserPromptSubmit',
        'working PreToolUse touch pc-hook-probe.txt',
        'waiting PermissionRequest touch pc-hook-probe.txt',
        'working PostToolUse',
        'done Interrupt Interrupted',
      ],
      activity: 'ready',
    });
  });

  it('ends the wait when the approval is declined, then follows the next turn', () => {
    expect(replay(DECLINED_THEN_COMPLETED)).toEqual({
      timeline: [
        'ignored',
        'working UserPromptSubmit',
        'working PreToolUse touch pc-hook-probe2.txt',
        'waiting PermissionRequest touch pc-hook-probe2.txt',
        'done Interrupt Interrupted',
        'working UserPromptSubmit',
        'done Stop',
      ],
      activity: 'turn_finished',
    });
  });

  it('waits on the approval of a file edit, and resumes once it is applied', () => {
    const patch = '*** Begin Patch *** Add File: /outside/note.txt +hello *** End Patch';
    expect(replay(PATCH_APPROVED)).toEqual({
      timeline: [
        'ignored',
        'working UserPromptSubmit',
        `working PreToolUse ${patch}`,
        `waiting PermissionRequest ${patch}`,
        'working PostToolUse',
        'done Stop',
      ],
      activity: 'turn_finished',
    });
  });

  it('waits on a question the model asks in Plan mode, and resumes once it is answered', () => {
    expect(replay(QUESTION_ANSWERED)).toEqual({
      timeline: [
        'ignored',
        'working UserPromptSubmit',
        'waiting PreToolUse Which one should I use?',
        'working PostToolUse',
        'done Stop',
      ],
      activity: 'turn_finished',
    });
  });
});

describe('mapCodexHookPayload', () => {
  it('asks for a permission answer and keeps the reply of a finished turn', () => {
    expect(mapCodexHookPayload(APPROVED_THEN_INTERRUPTED[3])).toEqual({
      state: 'waiting',
      event: 'PermissionRequest',
      prompt: 'permission',
      toolName: 'Bash',
      detail: 'touch pc-hook-probe.txt',
    });
    expect(mapCodexHookPayload(DECLINED_THEN_COMPLETED[6])).toEqual({
      state: 'done',
      event: 'Stop',
      lastAssistantMessage: 'All done.',
    });
  });

  it('ignores the tool calls of a sub-agent but not its permission request', () => {
    const tool = { tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'sub-1' };
    expect(mapCodexHookPayload({ hook_event_name: 'PreToolUse', ...tool })).toBeNull();
    expect(mapCodexHookPayload({ hook_event_name: 'PostToolUse', ...tool })).toBeNull();
    expect(mapCodexHookPayload({ hook_event_name: 'PermissionRequest', ...tool })).toMatchObject({
      state: 'waiting',
      prompt: 'permission',
    });
  });

  it("lets the lead's activity end a sub-agent's permission request, as its own calls are ignored", () => {
    const ask = {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      agent_id: 'sub-1',
    };
    const leadCall = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
      tool_use_id: 'exec-2',
    };
    expect(replay([ask, leadCall]).timeline).toEqual([
      'waiting PermissionRequest ls',
      'working PreToolUse pwd',
    ]);
  });

  it('ignores payloads that are not hook events', () => {
    expect(mapCodexHookPayload(null)).toBeNull();
    expect(mapCodexHookPayload({ cwd: '/work' })).toBeNull();
    expect(mapCodexHookPayload({ hook_event_name: 'SomethingNew' })).toBeNull();
  });
});
