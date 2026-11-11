import { describe, expect, it } from 'vitest';
import { mapClaudeHookPayload } from './status.js';
import { createToolCallMatcher } from './tool-calls.js';

/** The tool call id the last of `payloads` ends up with, replayed for one launch. */
function lastToolUseId(payloads: Record<string, unknown>[]): string | undefined {
  const match = createToolCallMatcher();
  const out = payloads.map((payload) => match('launch-1', payload, mapClaudeHookPayload(payload)));
  return out[out.length - 1]?.toolUseId;
}

const sub = (agentId?: string) => (agentId ? { agent_id: agentId } : {});
const call = (id: string, tool: string, input: unknown, agentId?: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: input,
  tool_use_id: id,
  ...sub(agentId),
});
// As Claude Code sends it: no tool_use_id.
const ask = (tool: string, input: unknown, agentId?: string) => ({
  hook_event_name: 'PermissionRequest',
  tool_name: tool,
  tool_input: input,
  ...sub(agentId),
});
const result = (id: string, event = 'PostToolUse') => ({
  hook_event_name: event,
  tool_name: 'Bash',
  tool_use_id: id,
});

describe('createToolCallMatcher', () => {
  it('gives a permission request the id of the open call with the same input', () => {
    expect(
      lastToolUseId([
        call('b1', 'Bash', { command: 'rm -rf dist' }),
        call('b2', 'Bash', { command: 'npm test' }),
        ask('Bash', { command: 'rm -rf dist' }),
      ]),
    ).toBe('b1');
  });

  it('prefers the latest of open calls with the same input, as a retry after a rejection', () => {
    // A rejected dialog interrupts the turn, so its call never gets a result.
    const input = { command: 'rm -rf dist' };
    expect(
      lastToolUseId([call('b1', 'Bash', input), call('b5', 'Bash', input), ask('Bash', input)]),
    ).toBe('b5');
  });

  it("falls back to the agent's latest open call of that tool", () => {
    expect(
      lastToolUseId([
        call('b1', 'Bash', { command: 'ls' }),
        call('b2', 'Bash', { command: 'pwd' }, 'a1'),
        call('b3', 'Bash', { command: 'npm test' }),
        call('r1', 'Read', { file_path: '/w/a.ts' }),
        ask('Bash', { command: 'npm test -- --watch=false' }),
      ]),
    ).toBe('b3');
    // Another agent's call is never the one asked about.
    expect(
      lastToolUseId([call('b1', 'Bash', { command: 'ls' }), ask('Bash', { command: 'ls' }, 'a1')]),
    ).toBeUndefined();
  });

  it('leaves the id unknown once the call has finished', () => {
    const input = { command: 'ls' };
    expect(lastToolUseId([call('b1', 'Bash', input), result('b1'), ask('Bash', input)])).toBe(
      undefined,
    );
    expect(
      lastToolUseId([
        call('b1', 'Bash', input),
        result('b1', 'PostToolUseFailure'),
        ask('Bash', input),
      ]),
    ).toBeUndefined();
  });

  it('forgets open calls when the turn ends or a new session starts, but not on compaction', () => {
    const input = { command: 'ls' };
    const after = (boundary: Record<string, unknown>) =>
      lastToolUseId([call('b1', 'Bash', input), boundary, ask('Bash', input)]);
    expect(after({ hook_event_name: 'Stop' })).toBeUndefined();
    expect(after({ hook_event_name: 'StopFailure', error: 'rate_limit' })).toBeUndefined();
    expect(after({ hook_event_name: 'SessionStart', source: 'clear' })).toBeUndefined();
    expect(after({ hook_event_name: 'SessionStart', source: 'compact' })).toBe('b1');
  });

  it('keeps the open calls of one launch from matching in another', () => {
    const match = createToolCallMatcher();
    const input = { command: 'ls' };
    const first = call('b1', 'Bash', input);
    match('launch-1', first, mapClaudeHookPayload(first));
    const second = ask('Bash', input);
    expect(match('launch-2', second, mapClaudeHookPayload(second))?.toolUseId).toBeUndefined();
  });

  it('forgets the oldest open calls and launches beyond its bounds', () => {
    // Calls whose result never came (a denied permission) must not pile up.
    const calls = Array.from({ length: 100 }, (_, n) => call(`b${n}`, 'Bash', { command: `${n}` }));
    expect(lastToolUseId([...calls, ask('Bash', { command: '0' })])).toBe('b99');
    expect(lastToolUseId([...calls, ask('Bash', { command: '50' })])).toBe('b50');
    // Nor must launches that died before their turn ended.
    const match = createToolCallMatcher();
    const input = { command: 'ls' };
    for (let n = 0; n < 100; n++) {
      const payload = call(`b${n}`, 'Bash', input);
      match(`launch-${n}`, payload, mapClaudeHookPayload(payload));
    }
    const late = ask('Bash', input);
    expect(match('launch-0', late, mapClaudeHookPayload(late))?.toolUseId).toBeUndefined();
    expect(match('launch-99', late, mapClaudeHookPayload(late))?.toolUseId).toBe('b99');
  });

  it('leaves other events and a request that already names its call alone', () => {
    const match = createToolCallMatcher();
    expect(match('launch-1', { hook_event_name: 'SubagentStart' }, null)).toBeNull();
    const named = { ...ask('Bash', { command: 'ls' }), tool_use_id: 'given' };
    expect(match('launch-1', named, mapClaudeHookPayload(named))?.toolUseId).toBe('given');
  });
});
