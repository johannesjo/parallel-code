import { describe, expect, it } from 'vitest';
import {
  isClaudeCommand,
  isQoderCommand,
  withClaudeHookSettings,
  withQoderHookSettings,
} from './launch-args.js';

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

describe('withQoderHookSettings', () => {
  it('appends --settings for qoder and respects the user-supplied flag', () => {
    expect(withQoderHookSettings('qoder', ['--continue'], '/q.json')).toEqual([
      '--continue',
      '--settings',
      '/q.json',
    ]);
    expect(withQoderHookSettings('/usr/local/bin/qoder', [], '/q.json')).toEqual([
      '--settings',
      '/q.json',
    ]);
    expect(withQoderHookSettings('qoder', ['--settings', '/mine.json'], '/q.json')).toEqual([
      '--settings',
      '/mine.json',
    ]);
  });

  it('leaves a differently named Qoder wrapper alone', () => {
    expect(withQoderHookSettings('my-qoder', [], '/q.json')).toEqual([]);
    expect(isQoderCommand('my-qoder')).toBe(false);
  });
});

describe('isClaudeCommand', () => {
  it('matches by basename only', () => {
    expect(isClaudeCommand('claude')).toBe(true);
    expect(isClaudeCommand('/a/b/claude')).toBe(true);
    expect(isClaudeCommand('claude-wrapper')).toBe(false);
  });
});
