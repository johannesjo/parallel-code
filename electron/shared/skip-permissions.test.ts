import { describe, expect, it } from 'vitest';
import { getSkipPermissionsArgs } from './skip-permissions.js';

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
