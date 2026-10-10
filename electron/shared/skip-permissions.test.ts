import { describe, expect, it } from 'vitest';
import { getSkipPermissionsArgs, stripPermissionBypassArgs } from './skip-permissions.js';

describe('getSkipPermissionsArgs', () => {
  it('answers for each built-in agent that takes a flag', () => {
    expect(getSkipPermissionsArgs('claude')).toEqual(['--dangerously-skip-permissions']);
    expect(getSkipPermissionsArgs('codex')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(getSkipPermissionsArgs('gemini')).toEqual(['--yolo']);
    expect(getSkipPermissionsArgs('kimi')).toEqual(['--yolo']);
    expect(getSkipPermissionsArgs('/usr/local/bin/kimi')).toEqual(['--yolo']);
    expect(getSkipPermissionsArgs('copilot')).toEqual(['--yolo']);
    expect(getSkipPermissionsArgs('agy')).toEqual(['--dangerously-skip-permissions']);
  });

  // Agents are stored as whatever the user configured, which is often an
  // absolute path from a version manager or a Homebrew prefix.
  it('matches on the basename of an absolute path', () => {
    expect(getSkipPermissionsArgs('/opt/homebrew/bin/claude')).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  // `command` is free text from the custom agent editor. A plain object-literal
  // lookup resolves inherited keys to prototype members, which are truthy and
  // not iterable, so spreading one throws where this must return nothing. Same
  // class of bug as the one `isKnownTask` guards in remoteTaskHandler.
  it.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
    'returns nothing, without throwing, for the inherited key %s',
    (key) => {
      expect(getSkipPermissionsArgs(key)).toEqual([]);
      expect(getSkipPermissionsArgs(`/usr/local/bin/${key}`)).toEqual([]);
    },
  );

  // path.basename, which this replaced, ignores a trailing slash.
  it('ignores a trailing slash, as path.basename does', () => {
    expect(getSkipPermissionsArgs('claude/')).toEqual(['--dangerously-skip-permissions']);
    expect(getSkipPermissionsArgs('/usr/local/bin/claude/')).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('returns nothing for an agent that takes no such flag', () => {
    expect(getSkipPermissionsArgs('opencode')).toEqual([]);
    expect(getSkipPermissionsArgs('/usr/local/bin/some-other-cli')).toEqual([]);
    expect(getSkipPermissionsArgs('')).toEqual([]);
    expect(getSkipPermissionsArgs('/')).toEqual([]);
  });

  // Moved with the function from electron/ipc/agents.test.ts: the table is
  // shared across every call site, so handing out a reference would let one
  // caller's argv construction edit what the next one reads.
  it('returns a copy of default skip-permission args', () => {
    const first = getSkipPermissionsArgs('claude');
    first.push('--mutated');

    expect(getSkipPermissionsArgs('claude')).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('stripPermissionBypassArgs', () => {
  it('drops bare bypass flags, including equivalents of the launch flag', () => {
    expect(
      stripPermissionBypassArgs('claude', [
        '--allow-dangerously-skip-permissions',
        '--model',
        'x',
        '--dangerously-skip-permissions',
      ]),
    ).toEqual(['--model', 'x']);
    expect(stripPermissionBypassArgs('gemini', ['-y', '--yolo', '-m', 'a'])).toEqual(['-m', 'a']);
    expect(stripPermissionBypassArgs('copilot', ['--allow-all', '--allow-all-tools'])).toEqual([]);
  });

  it('drops dangerous values in both spaced and = forms and keeps safe ones', () => {
    expect(
      stripPermissionBypassArgs('claude', ['--permission-mode', 'bypassPermissions', '--verbose']),
    ).toEqual(['--verbose']);
    expect(stripPermissionBypassArgs('claude', ['--permission-mode=bypassPermissions'])).toEqual(
      [],
    );
    expect(stripPermissionBypassArgs('claude', ['--permission-mode', 'plan'])).toEqual([
      '--permission-mode',
      'plan',
    ]);
    expect(
      stripPermissionBypassArgs('codex', ['-s', 'danger-full-access', '-a', 'never', 'go']),
    ).toEqual(['go']);
    expect(stripPermissionBypassArgs('codex', ['--sandbox=danger-full-access'])).toEqual([]);
    expect(stripPermissionBypassArgs('codex', ['-s', 'workspace-write'])).toEqual([
      '-s',
      'workspace-write',
    ]);
    expect(stripPermissionBypassArgs('gemini', ['--approval-mode', 'yolo'])).toEqual([]);
  });

  it('drops codex aliases, attached short values and config overrides', () => {
    expect(stripPermissionBypassArgs('codex', ['--yolo', 'go'])).toEqual(['go']);
    expect(
      stripPermissionBypassArgs('codex', ['-sdanger-full-access', '-s=danger-full-access']),
    ).toEqual([]);
    expect(stripPermissionBypassArgs('codex', ['-anever', '-a=never', '-auntrusted'])).toEqual([
      '-auntrusted',
    ]);
    expect(
      stripPermissionBypassArgs('codex', [
        '-c',
        'approval_policy="never"',
        '--config=sandbox_mode=danger-full-access',
        '-c',
        'model="o3"',
        '-c',
        'sandbox_mode=read-only',
      ]),
    ).toEqual(['-c', 'model="o3"', '-c', 'sandbox_mode=read-only']);
    expect(
      stripPermissionBypassArgs('codex', [
        '-c',
        'approval_policy="never" # c',
        '-c',
        'approval_policy="""never"""',
        '-c',
        "approval_policy = 'never'",
      ]),
    ).toEqual([]);
  });

  it('drops profile-scoped codex overrides and hook-trust bypass', () => {
    expect(
      stripPermissionBypassArgs('codex', [
        '-c',
        'profiles.fast.approval_policy=never',
        '--dangerously-bypass-hook-trust',
        '-c',
        'profiles.fast.model=o3',
      ]),
    ).toEqual(['-c', 'profiles.fast.model=o3']);
  });

  it('drops the camelCase gemini approval mode', () => {
    expect(
      stripPermissionBypassArgs('gemini', ['--approvalMode', 'yolo', '--approvalMode=yolo']),
    ).toEqual([]);
  });

  it('drops claude settings that enable bypass mode', () => {
    expect(
      stripPermissionBypassArgs('claude', [
        '--settings',
        '{"permissions":{"defaultMode":"bypassPermissions"}}',
        '--settings',
        'team.json',
      ]),
    ).toEqual(['--settings', 'team.json']);
  });

  it('matches on basename and strips the union for unknown commands', () => {
    expect(stripPermissionBypassArgs('/opt/bin/codex', ['--yolo'])).toEqual([]);
    expect(stripPermissionBypassArgs('/opt/bin/claude', ['-y'])).toEqual(['-y']);
    expect(stripPermissionBypassArgs('my-wrapper', ['--yolo', '-a', 'never', 'x'])).toEqual(['x']);
  });

  it('keeps a wrapper short flag such as npx -y but strips the wrapped agent one', () => {
    expect(stripPermissionBypassArgs('npx', ['-y', '@google/gemini-cli', '-y', '--yolo'])).toEqual([
      '-y',
      '@google/gemini-cli',
    ]);
  });
});
