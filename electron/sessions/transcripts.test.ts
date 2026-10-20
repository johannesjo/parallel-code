import { describe, expect, it } from 'vitest';
import {
  claudeProjectSlug,
  codexTitleFrom,
  parseClaudeTranscript,
  parseCodexTranscript,
} from './transcripts.js';

const CWD = '/home/u/www/parallel-code/.worktrees/task/some-task-b8c101';
const CLAUDE_ID = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';

describe('claudeProjectSlug', () => {
  // Both observed transformations in one path: separators and the dot of
  // `.worktrees`, which together produce the doubled dash.
  it('flattens separators and dots', () => {
    expect(claudeProjectSlug(CWD)).toBe(
      '-home-u-www-parallel-code--worktrees-task-some-task-b8c101',
    );
  });

  it('leaves a plain project path with single dashes', () => {
    expect(claudeProjectSlug('/home/u/www/marketing')).toBe('-home-u-www-marketing');
  });
});

describe('parseClaudeTranscript', () => {
  const entries = [
    { type: 'mode', mode: 'normal', sessionId: CLAUDE_ID },
    {
      type: 'user',
      sessionId: CLAUDE_ID,
      cwd: CWD,
      gitBranch: 'task/some-task-b8c101',
      timestamp: '2026-08-27T16:38:49.568Z',
    },
    { type: 'ai-title', aiTitle: 'First title', sessionId: CLAUDE_ID },
    { type: 'last-prompt', lastPrompt: 'earlier exchange', sessionId: CLAUDE_ID },
    { type: 'ai-title', aiTitle: 'Agent switching improvements', sessionId: CLAUDE_ID },
    { type: 'last-prompt', lastPrompt: 'How to best improve this?', sessionId: CLAUDE_ID },
  ];

  it('reads identity, cwd and branch from the body', () => {
    const record = parseClaudeTranscript(entries, CLAUDE_ID);
    expect(record).toMatchObject({
      id: CLAUDE_ID,
      agent: 'claude',
      cwd: CWD,
      branch: 'task/some-task-b8c101',
      startedAt: Date.parse('2026-08-27T16:38:49.568Z'),
    });
  });

  // Claude appends a fresh title/prompt line per turn instead of rewriting.
  it('keeps the last title and prompt, not the first', () => {
    const record = parseClaudeTranscript(entries, CLAUDE_ID);
    expect(record?.title).toBe('Agent switching improvements');
    expect(record?.lastPrompt).toBe('How to best improve this?');
  });

  it('falls back to the filename when no entry carries a sessionId', () => {
    const record = parseClaudeTranscript([{ type: 'user', cwd: CWD }], CLAUDE_ID);
    expect(record?.id).toBe(CLAUDE_ID);
  });

  it('collapses whitespace and clips a long prompt', () => {
    const record = parseClaudeTranscript(
      [
        { type: 'user', cwd: CWD },
        { type: 'last-prompt', lastPrompt: `a\n\n  b ${'x'.repeat(500)}` },
      ],
      CLAUDE_ID,
    );
    expect(record?.lastPrompt?.startsWith('a b xxx')).toBe(true);
    expect(record?.lastPrompt).toHaveLength(400);
    expect(record?.lastPrompt?.endsWith('…')).toBe(true);
  });

  // Without a cwd the record cannot be matched to a worktree, so it is not a
  // usable session — better absent than keyed on a guess.
  it('returns null without a cwd', () => {
    expect(parseClaudeTranscript([{ type: 'mode', sessionId: CLAUDE_ID }], CLAUDE_ID)).toBeNull();
  });

  it('returns null with no id anywhere', () => {
    expect(parseClaudeTranscript([{ type: 'user', cwd: CWD }], '')).toBeNull();
  });

  it('survives junk entries', () => {
    const record = parseClaudeTranscript(
      [null, 42, 'text', [], { type: 'user', cwd: CWD, sessionId: CLAUDE_ID }],
      CLAUDE_ID,
    );
    expect(record?.id).toBe(CLAUDE_ID);
  });
});

describe('parseCodexTranscript', () => {
  const CODEX_ID = '019b8f10-cf67-7b20-80f5-8f7e6ba12505';
  const meta = {
    type: 'session_meta',
    payload: {
      id: CODEX_ID,
      cwd: CWD,
      timestamp: '2026-01-05T16:50:02.215Z',
      git: { branch: 'task/some-task-b8c101', commit_hash: '4bb51fa8' },
    },
  };

  it('reads identity, cwd and branch from session_meta', () => {
    expect(parseCodexTranscript([meta])).toMatchObject({
      id: CODEX_ID,
      agent: 'codex',
      cwd: CWD,
      branch: 'task/some-task-b8c101',
      startedAt: Date.parse('2026-01-05T16:50:02.215Z'),
    });
  });

  // Codex prepends AGENTS.md to the first user turn; titling a session with the
  // project's own instructions would make every session look identical.
  it('skips the injected AGENTS.md turn when titling', () => {
    const record = parseCodexTranscript([
      meta,
      {
        type: 'response_item',
        payload: {
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /home/u\n<...>' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          role: 'user',
          content: [{ type: 'input_text', text: 'would it be possible to build a custom UI?' }],
        },
      },
    ]);
    expect(record?.title).toBe('would it be possible to build a custom UI?');
  });

  // Observed shape: one first message carrying both injected blocks as parts,
  // with the user's actual prompt only arriving in the next message.
  it('skips every injected part of the first turn', () => {
    const record = parseCodexTranscript([
      meta,
      {
        type: 'response_item',
        payload: {
          role: 'user',
          content: [
            { type: 'input_text', text: '# AGENTS.md instructions for /home/u\n<INSTRUCTIONS>' },
            { type: 'input_text', text: '<environment_context>\n  <cwd>/home/u</cwd>' },
          ],
        },
      },
      {
        type: 'response_item',
        payload: {
          role: 'user',
          content: [{ type: 'input_text', text: 'add a session picker' }],
        },
      },
    ]);
    expect(record?.title).toBe('add a session picker');
  });

  it('ignores assistant turns when titling', () => {
    const record = parseCodexTranscript([
      meta,
      {
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Sure.' }] },
      },
    ]);
    expect(record?.title).toBeUndefined();
  });

  it('titles from the earliest user turn and takes the last prompt from the latest', () => {
    const userTurn = (text: string) => ({
      type: 'response_item',
      payload: { role: 'user', content: [{ type: 'input_text', text }] },
    });
    const record = parseCodexTranscript([meta, userTurn('opening ask'), userTurn('latest ask')]);
    expect(record?.title).toBe('opening ask');
    expect(record?.lastPrompt).toBe('latest ask');
  });

  it('omits the last prompt when the session has a single turn', () => {
    const record = parseCodexTranscript([
      meta,
      {
        type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text: 'only ask' }] },
      },
    ]);
    expect(record?.title).toBe('only ask');
    expect(record?.lastPrompt).toBeUndefined();
  });

  it('returns null without session_meta', () => {
    expect(parseCodexTranscript([{ type: 'event_msg', payload: {} }])).toBeNull();
  });

  it('returns null when session_meta carries no cwd', () => {
    expect(parseCodexTranscript([{ type: 'session_meta', payload: { id: CODEX_ID } }])).toBeNull();
  });
});

function userTurn(text: string): unknown {
  return {
    type: 'response_item',
    payload: { role: 'user', content: [{ type: 'input_text', text }] },
  };
}

function agentTurn(text: string): unknown {
  return {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'AgentMessage', content: [{ type: 'Text', text }] },
    },
  };
}

describe('codexTitleFrom', () => {
  it('prefers the user opening the session', () => {
    expect(codexTitleFrom([userTurn('fix the parser'), agentTurn('I will fix the parser')])).toBe(
      'fix the parser',
    );
  });

  // Order in the file does not decide it: the agent speaks first in plenty of
  // transcripts, and the user's own words are still the better title.
  it('prefers the user even when the agent spoke first', () => {
    expect(codexTitleFrom([agentTurn('I will fix the parser'), userTurn('fix the parser')])).toBe(
      'fix the parser',
    );
  });

  // Codex's sub-agent sessions have no user turn at all — nobody typed into
  // them — and they are most of what a busy worktree accumulates. Without this
  // every one of their rows reads "Session <8 hex>".
  it('falls back to the agent when no one typed', () => {
    expect(codexTitleFrom([agentTurn('I am applying the code-simplification skill')])).toBe(
      'I am applying the code-simplification skill',
    );
  });

  it('ignores the injected preamble when choosing', () => {
    expect(
      codexTitleFrom([
        userTurn('<environment_context>\n  <cwd>/home/u</cwd>'),
        userTurn('# AGENTS.md instructions for /home/u'),
        agentTurn('I will get started'),
      ]),
    ).toBe('I will get started');
  });

  it('returns nothing when the window held neither', () => {
    expect(
      codexTitleFrom([{ type: 'event_msg', payload: { type: 'token_count' } }]),
    ).toBeUndefined();
  });

  it('ignores an AgentMessage with no text', () => {
    expect(
      codexTitleFrom([
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning' } } },
        agentTurn('after the reasoning block'),
      ]),
    ).toBe('after the reasoning block');
  });
});
