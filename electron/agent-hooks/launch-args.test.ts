import { describe, expect, it } from 'vitest';
import { isClaudeCommand, withClaudeHookSettings } from './launch-args.js';

describe('withClaudeHookSettings', () => {
  it('appends --settings for claude, including absolute paths', () => {
    expect(withClaudeHookSettings('claude', ['--continue'], '/s.json')).toEqual([
      '--continue',
      '--settings',
      '/s.json',
    ]);
    expect(withClaudeHookSettings('/usr/local/bin/claude', [], '/s.json')).toEqual([
      '--settings',
      '/s.json',
    ]);
  });

  it('leaves other agents and wrapper scripts untouched', () => {
    expect(withClaudeHookSettings('codex', ['resume'], '/s.json')).toEqual(['resume']);
    expect(withClaudeHookSettings('/opt/my-claude-wrapper', [], '/s.json')).toEqual([]);
  });

  it('respects a user-supplied --settings instead of stacking a second one', () => {
    expect(withClaudeHookSettings('claude', ['--settings', '/mine.json'], '/s.json')).toEqual([
      '--settings',
      '/mine.json',
    ]);
    expect(withClaudeHookSettings('claude', ['--settings=/mine.json'], '/s.json')).toEqual([
      '--settings=/mine.json',
    ]);
  });

  it('does not mutate the input array', () => {
    const args = ['--continue'];
    withClaudeHookSettings('claude', args, '/s.json');
    expect(args).toEqual(['--continue']);
  });
});

describe('isClaudeCommand', () => {
  it('matches by basename only', () => {
    expect(isClaudeCommand('claude')).toBe(true);
    expect(isClaudeCommand('/a/b/claude')).toBe(true);
    expect(isClaudeCommand('claude-wrapper')).toBe(false);
  });
});
