import { describe, expect, it } from 'vitest';
import { mapClaudeHookPayload } from './status.js';
import { createSubagentGate } from './subagents.js';

/** Replays raw hook payloads for one launch; returns the updates that pass the gate. */
function replay(payloads: Record<string, unknown>[], launchId = 'launch-1') {
  const gate = createSubagentGate();
  return payloads.map((payload) => gate(launchId, payload, mapClaudeHookPayload(payload)));
}

const start = (id: string) => ({ hook_event_name: 'SubagentStart', agent_id: id });
const stop = (id: string) => ({ hook_event_name: 'SubagentStop', agent_id: id });
const turnEnd = { hook_event_name: 'Stop', last_assistant_message: 'started' };
const idle = { hook_event_name: 'Notification', notification_type: 'idle_prompt' };
const bash = (id: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: id });

describe('createSubagentGate', () => {
  it('holds the turn open while a background sub-agent runs', () => {
    // Recorded from Claude Code 2.1.312, including a stop with no matching start.
    const out = replay([
      { hook_event_name: 'PreToolUse', tool_name: 'Agent' },
      start('a1'),
      turnEnd,
      stop('internal'),
      bash('a1'),
      idle,
      stop('a1'),
      turnEnd,
    ]);
    expect(out.map((update) => update?.state ?? null)).toEqual([
      'working',
      null,
      'working',
      null,
      'working',
      'working',
      null,
      'done',
    ]);
    // Flagged while the sub-agent runs, so keys typed at the lead's prompt read as no interrupt.
    expect(out.map((update) => update?.background ?? false)).toEqual([
      false,
      false,
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
    // The lead's reply survives on the held turn end.
    expect(out[2]).toMatchObject({ event: 'SubagentRunning', lastAssistantMessage: 'started' });
  });

  it('keeps sub-agents of one launch from holding another open', () => {
    const gate = createSubagentGate();
    gate('launch-1', start('a1'), null);
    expect(gate('launch-2', turnEnd, mapClaudeHookPayload(turnEnd))).toMatchObject({
      state: 'done',
    });
    expect(gate('launch-2', turnEnd, mapClaudeHookPayload(turnEnd))?.background).toBeUndefined();
  });

  it('forgets open sub-agents when a new session starts', () => {
    const startup = { hook_event_name: 'SessionStart', source: 'clear' };
    const out = replay([start('a1'), startup, turnEnd]);
    expect(out.map((update) => update?.state ?? null)).toEqual([null, 'done', 'done']);
  });

  it("resyncs open sub-agents from Claude's background task list", () => {
    // Recorded: a helper's stop lists the sub-agents still running, and a
    // sub-agent's own stop still lists itself.
    const running = (id: string) => [
      { id, type: 'subagent', status: 'running' },
      { id: 'shell-1', type: 'shell', status: 'running' },
    ];
    const lost = replay([start('a1'), { ...stop('helper'), background_tasks: [] }, turnEnd]);
    expect(lost[2]?.state).toBe('done');
    const unseen = replay([{ ...stop('helper'), background_tasks: running('a1') }, turnEnd]);
    expect(unseen[1]?.state).toBe('working');
    const own = replay([start('a1'), { ...stop('a1'), background_tasks: running('a1') }, turnEnd]);
    expect(own[2]?.state).toBe('done');
  });

  it('flags only a lead that ended its turn, so Esc can still interrupt a live one', () => {
    const leadTool = { hook_event_name: 'PreToolUse', tool_name: 'Read' };
    const out = replay([
      { hook_event_name: 'PreToolUse', tool_name: 'Agent' },
      start('a1'),
      bash('a1'),
      turnEnd,
      bash('a1'),
      leadTool,
      bash('a1'),
    ]);
    expect(out.map((update) => update?.background ?? false)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  it('holds the turn open while a workflow runs and reports its agents', () => {
    // Recorded from Claude Code 2.1.312: between phases Claude lists only the
    // workflow itself, never its agents.
    const workflow = [{ id: 'w1', type: 'workflow', status: 'running', name: 'tiny' }];
    const agentStart = (id: string) => ({ ...start(id), agent_type: 'workflow-subagent' });
    const agentStop = (id: string) => ({
      ...stop(id),
      agent_type: 'workflow-subagent',
      background_tasks: workflow,
    });
    const out = replay([
      { hook_event_name: 'PostToolUse', tool_name: 'Workflow' },
      agentStart('a1'),
      agentStop('a1'),
      { ...turnEnd, background_tasks: workflow },
      idle,
      agentStart('a2'),
      agentStop('a2'),
      { hook_event_name: 'UserPromptSubmit' },
      { ...turnEnd, background_tasks: [] },
    ]);
    expect(out.map((update) => update?.state ?? null)).toEqual([
      'working',
      null,
      null,
      'working',
      'working',
      'working',
      'working',
      'working',
      'done',
    ]);
    expect(out[3]).toMatchObject({
      toolName: 'Workflow',
      detail: 'tiny · 0 running · 1 done',
      lastAssistantMessage: 'started',
      background: true,
    });
    // The idle reminder must not erase the lead's reply from later progress.
    expect(out[4]).toMatchObject({ detail: 'tiny · 0 running · 1 done', background: true });
    expect(out[5]).toMatchObject({
      detail: 'tiny · 1 running · 1 done',
      lastAssistantMessage: 'started',
    });
    expect(out[6]).toMatchObject({ detail: 'tiny · 0 running · 2 done', background: true });
    expect(out[7]?.background).toBeUndefined();
  });

  it('replays an interactive workflow run through to its release', () => {
    // Recorded from an interactive Claude Code 2.1.312 session, helper stops included.
    const listed = {
      background_tasks: [{ id: 'w1', type: 'workflow', status: 'running', name: 'tiny' }],
    };
    const agent = { agent_type: 'workflow-subagent' };
    const out = replay([
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'PostToolUse', tool_name: 'Workflow' },
      { ...start('a1'), ...agent },
      { ...stop('a1'), ...agent, ...listed },
      { ...turnEnd, ...listed },
      { ...start('a2'), ...agent },
      { ...stop('helper'), agent_type: '', ...listed },
      { ...stop('a2'), ...agent, ...listed },
      { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>' },
      { ...turnEnd, background_tasks: [] },
      { ...stop('helper2'), agent_type: '', background_tasks: [] },
    ]);
    expect(out.map((update) => update?.detail ?? update?.state ?? null)).toEqual([
      'working',
      'working',
      null,
      null,
      'tiny · 0 running · 1 done',
      'tiny · 1 running · 1 done',
      'tiny · 1 running · 1 done',
      'tiny · 0 running · 2 done',
      'working',
      'done',
      null,
    ]);
  });

  it('releases a workflow stopped with TaskStop, whose agent never reports a stop', () => {
    // Recorded from Claude Code 2.1.312: no SubagentStop follows the kill.
    const out = replay([
      { hook_event_name: 'PostToolUse', tool_name: 'Workflow' },
      { ...start('a1'), agent_type: 'workflow-subagent' },
      { hook_event_name: 'PostToolUse', tool_name: 'TaskStop' },
      { ...turnEnd, background_tasks: [] },
    ]);
    expect(out[3]?.state).toBe('done');
  });

  it('starts counting afresh for a workflow launched after the last one ended', () => {
    const listing = (name?: string) => [
      { id: 's1', type: 'subagent', status: 'running' },
      ...(name ? [{ id: name, type: 'workflow', status: 'running', name }] : []),
    ];
    const agentStart = (id: string) => ({ ...start(id), agent_type: 'workflow-subagent' });
    const out = replay([
      start('s1'),
      agentStart('a1'),
      { ...stop('a1'), background_tasks: listing('first') },
      { ...turnEnd, background_tasks: listing() },
      agentStart('a2'),
      { ...stop('helper'), background_tasks: listing('second') },
    ]);
    // A plain sub-agent outlives the first workflow, so the hold never lapses.
    expect(out[3]).toMatchObject({ state: 'working', event: 'SubagentRunning' });
    expect(out[3]?.toolName).toBeUndefined();
    expect(out[5]?.detail).toBe('second · 1 running · 0 done');
  });

  it("keeps one workflow agent's prompt visible through its siblings' progress", () => {
    const workflow = [{ id: 'w1', type: 'workflow', status: 'running', name: 'tiny' }];
    const agent = { agent_type: 'workflow-subagent' };
    const result = (id: string, toolUseId: string) => ({
      hook_event_name: 'PostToolUse',
      agent_id: id,
      tool_use_id: toolUseId,
    });
    const out = replay([
      { ...start('a1'), ...agent },
      { ...start('a2'), ...agent },
      { ...turnEnd, background_tasks: workflow },
      {
        hook_event_name: 'PermissionRequest',
        agent_id: 'a1',
        tool_name: 'Bash',
        tool_use_id: 't1',
      },
      { ...stop('a2'), ...agent, background_tasks: workflow },
      result('a3', 't2'),
      { ...start('a3'), ...agent },
      result('a1', 't1'),
    ]);
    expect(out[3]).toMatchObject({ state: 'waiting', background: true });
    // Sibling progress says nothing; a sibling's result is left to the reducer to ignore.
    expect(out[4]).toBeNull();
    expect(out[5]).toMatchObject({ event: 'PostToolUse', toolUseId: 't2' });
    expect(out[6]).toBeNull();
    // The prompt's own result ends it, and progress resumes.
    expect(out[7]).toMatchObject({ toolName: 'Workflow', detail: 'tiny · 2 running · 1 done' });
  });

  it('does not hold the turn open for a background shell command', () => {
    const shell = [{ id: 'b1', type: 'shell', status: 'running', description: 'Run dev server' }];
    expect(replay([{ ...turnEnd, background_tasks: shell }])[0]?.state).toBe('done');
  });

  it('passes questions through while a sub-agent runs', () => {
    const ask = { hook_event_name: 'Notification', notification_type: 'permission_prompt' };
    expect(replay([start('a1'), ask])[1]?.state).toBe('waiting');
  });
});
