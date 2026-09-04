import { describe, expect, it } from 'vitest';
import { buildHeadlessLaunch, createHeadlessParser, CLAUDE_DOCUMENT_TOOLS } from './agents.js';

describe('buildHeadlessLaunch', () => {
  it('starts a fresh claude session with a fixed id and no shell tools', () => {
    const launch = buildHeadlessLaunch({
      agentId: 'claude-code',
      command: 'claude',
      prompt: 'Do it',
      newSessionId: 'sid-1',
    });
    expect(launch.command).toBe('claude');
    expect(launch.args).toContain('--session-id');
    expect(launch.args).toContain('sid-1');
    expect(launch.args).not.toContain('--resume');
    const toolsIdx = launch.args.indexOf('--tools');
    expect(launch.args[toolsIdx + 1]).toBe(CLAUDE_DOCUMENT_TOOLS);
    expect(launch.args).not.toContain('--dangerously-skip-permissions');
  });

  it('resumes claude by session id', () => {
    const launch = buildHeadlessLaunch({
      agentId: 'claude-code',
      command: 'claude',
      prompt: 'Again',
      sessionId: 'old',
      newSessionId: 'new',
    });
    expect(launch.args).toContain('--resume');
    expect(launch.args).toContain('old');
    expect(launch.args).not.toContain('--session-id');
  });

  it('puts codex flags before the resume subcommand', () => {
    const launch = buildHeadlessLaunch({
      agentId: 'codex',
      command: 'codex',
      prompt: 'P',
      sessionId: 'thread-1',
      newSessionId: 'x',
    });
    expect(launch.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(launch.args.indexOf('resume')).toBeGreaterThan(launch.args.indexOf('--sandbox'));
    expect(launch.args.slice(-2)).toEqual(['thread-1', 'P']);
  });

  it('ignores a session id for agents that cannot resume', () => {
    const launch = buildHeadlessLaunch({
      agentId: 'gemini',
      command: 'gemini',
      prompt: 'P',
      sessionId: 'ignored',
      newSessionId: 'x',
    });
    expect(launch.args).not.toContain('ignored');
  });

  it('rejects agents without a headless mode', () => {
    expect(() =>
      buildHeadlessLaunch({
        agentId: 'antigravity',
        command: 'agy',
        prompt: 'P',
        newSessionId: 'x',
      }),
    ).toThrow(/no headless mode/);
  });
});

describe('claude stream-json parser', () => {
  it('collects session id, tool log lines and the final result across chunks', () => {
    const parser = createHeadlessParser('claude-code');
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Looking' },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'docs/a.md' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Final ```json\n{}\n```',
        session_id: 's1',
      }),
    ];
    const joined = lines.join('\n') + '\n';
    const log = [...parser.feed(joined.slice(0, 40)), ...parser.feed(joined.slice(40))];
    expect(log).toEqual(['session started', 'Looking', '→ Edit docs/a.md']);
    const outcome = parser.finish();
    expect(outcome.sessionId).toBe('s1');
    expect(outcome.resultText).toContain('Final');
    expect(outcome.error).toBeUndefined();
  });

  it('surfaces an error result', () => {
    const parser = createHeadlessParser('claude-code');
    parser.feed(
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom' }) + '\n',
    );
    expect(parser.finish().error).toBe('boom');
  });

  it('passes non-json lines through and falls back to assistant text', () => {
    const parser = createHeadlessParser('claude-code');
    const log = parser.feed('warning: something\n');
    expect(log).toEqual(['warning: something']);
    parser.feed(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'T' }] } }),
    );
    expect(parser.finish().resultText).toBe('T');
  });
});

describe('codex jsonl parser', () => {
  it('reads the thread id, file changes and last agent message', () => {
    const parser = createHeadlessParser('codex');
    const events = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
      {
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'a.md', kind: 'update' }] },
      },
      { type: 'item.completed', item: { type: 'agent_message', text: 'last' } },
      { type: 'turn.completed', usage: {} },
    ];
    const log = parser.feed(events.map((e) => JSON.stringify(e)).join('\n'));
    expect(log).toEqual(['session started', 'first', '→ update a.md', 'last']);
    const outcome = parser.finish();
    expect(outcome.sessionId).toBe('t1');
    expect(outcome.resultText).toBe('last');
  });

  it('records stream errors', () => {
    const parser = createHeadlessParser('codex');
    parser.feed(JSON.stringify({ type: 'error', message: 'quota' }) + '\n');
    expect(parser.finish().error).toBe('quota');
  });
});

describe('gemini and plain parsers', () => {
  it('extracts the gemini response', () => {
    const parser = createHeadlessParser('gemini');
    parser.feed('{"response": "hello", ');
    parser.feed('"session_id": "g1"}');
    expect(parser.finish()).toEqual({ resultText: 'hello', sessionId: 'g1', error: undefined });
  });

  it('treats unparseable gemini output as text', () => {
    const parser = createHeadlessParser('gemini');
    parser.feed('plain');
    expect(parser.finish().resultText).toBe('plain');
  });

  it('keeps everything for plain-text agents', () => {
    const parser = createHeadlessParser('custom-agent');
    const log = parser.feed('one\ntwo\n');
    expect(log).toEqual(['one', 'two']);
    expect(parser.finish().resultText).toBe('one\ntwo\n');
  });
});
