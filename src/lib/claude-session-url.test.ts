import { describe, expect, it } from 'vitest';
import {
  isClaudeSessionUrl,
  parseClaudeSessionUrl,
  parseTeleportRepoMismatch,
} from './claude-session-url';

describe('parseClaudeSessionUrl', () => {
  it('extracts the session id from a web session URL', () => {
    expect(parseClaudeSessionUrl('https://claude.ai/code/session_011CUabcXYZ')).toBe(
      'session_011CUabcXYZ',
    );
    expect(parseClaudeSessionUrl('  https://claude.ai/code/session_01Ab/?x=1#y \n')).toBe(
      'session_01Ab',
    );
  });

  it('rejects other hosts, paths and schemes', () => {
    expect(parseClaudeSessionUrl('https://evil.example/code/session_01Ab')).toBeNull();
    expect(parseClaudeSessionUrl('http://claude.ai/code/session_01Ab')).toBeNull();
    expect(parseClaudeSessionUrl('https://claude.ai/chat/session_01Ab')).toBeNull();
    expect(parseClaudeSessionUrl('https://claude.ai/code')).toBeNull();
    expect(parseClaudeSessionUrl('https://claude.ai/code/session_01Ab/extra')).toBeNull();
    expect(parseClaudeSessionUrl('https://user@claude.ai/code/session_01Ab')).toBeNull();
    expect(parseClaudeSessionUrl('not a url')).toBeNull();
  });

  it('rejects ids that could be read as CLI flags or carry odd characters', () => {
    expect(parseClaudeSessionUrl('https://claude.ai/code/--dangerously-skip')).toBeNull();
    expect(parseClaudeSessionUrl('https://claude.ai/code/session_a%20b')).toBeNull();
    expect(isClaudeSessionUrl('https://github.com/o/r/pull/1')).toBe(false);
  });
});

describe('parseTeleportRepoMismatch', () => {
  it('reads the repo from the CLI error, bold or plain', () => {
    expect(
      parseTeleportRepoMismatch([
        'You must run claude --teleport session_01Ab from a checkout of \x1b[1macme/web.app\x1b[22m.',
        'This repo is acme/other.',
      ]),
    ).toBe('web.app');
    expect(
      parseTeleportRepoMismatch([
        'You must run claude --teleport session_01Ab from a checkout of ghe.example.com/acme/api.',
      ]),
    ).toBe('api');
  });

  it('ignores other output', () => {
    expect(parseTeleportRepoMismatch(['Error: session not found'])).toBeNull();
    expect(parseTeleportRepoMismatch([])).toBeNull();
  });
});
