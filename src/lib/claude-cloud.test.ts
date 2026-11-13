import { describe, expect, it } from 'vitest';
import { cloudLaunchArgs, isClaudeCommand, remoteControlCommand } from './claude-cloud';

describe('isClaudeCommand', () => {
  it('matches the claude CLI by name or path', () => {
    expect(isClaudeCommand('claude')).toBe(true);
    expect(isClaudeCommand('/usr/local/bin/claude')).toBe(true);
    expect(isClaudeCommand('C:\\Users\\me\\bin\\claude')).toBe(true);
  });

  it('rejects other agents', () => {
    expect(isClaudeCommand('codex')).toBe(false);
    expect(isClaudeCommand('/opt/claude-wrapper')).toBe(false);
  });
});

describe('remoteControlCommand', () => {
  it('names the session after the task on the first run', () => {
    expect(remoteControlCommand('Fix login bug', true)).toBe('/remote-control Fix login bug');
  });

  it('keeps a multi-line name on one line', () => {
    expect(remoteControlCommand('  Fix\nlogin\t bug ', true)).toBe('/remote-control Fix login bug');
  });

  it('caps a long name', () => {
    expect(remoteControlCommand('a'.repeat(200), true)).toBe(`/remote-control ${'a'.repeat(80)}`);
  });

  it('opens the status panel without a name once connected', () => {
    expect(remoteControlCommand('Fix login bug', false)).toBe('/remote-control');
  });

  it('omits an empty name', () => {
    expect(remoteControlCommand('   ', true)).toBe('/remote-control');
  });
});

describe('cloudLaunchArgs', () => {
  it('passes the trimmed prompt as one argument', () => {
    expect(cloudLaunchArgs('  Finish the "auth" refactor; run $(tests)\n')).toEqual([
      '--cloud=Finish the "auth" refactor; run $(tests)',
    ]);
  });

  it('keeps a prompt that starts with a dash from being read as a flag', () => {
    expect(cloudLaunchArgs('-v is broken')).toEqual(['--cloud=-v is broken']);
  });
});
