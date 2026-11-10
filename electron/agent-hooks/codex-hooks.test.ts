import { describe, expect, it } from 'vitest';
import {
  buildCodexHookOverrides,
  buildCodexTrustOverride,
  codexConfigArgs,
  hasCodexHookOverride,
  isCodexCommand,
} from './codex-hooks.js';

describe('buildCodexHookOverrides', () => {
  it('registers the hook script for every status event', () => {
    const turn = (event: string, timeout: number) =>
      `hooks.${event}=[{hooks=[{type="command",command="/bin/sh '/data/codex-hook.sh'",timeout=${timeout}}]}]`;
    const tool = (event: string) =>
      `hooks.${event}=[{matcher="*",hooks=[{type="command",command="/bin/sh '/data/codex-hook.sh'",timeout=10}]}]`;
    expect(buildCodexHookOverrides('/data/codex-hook.sh')).toEqual([
      turn('UserPromptSubmit', 10),
      tool('PreToolUse'),
      tool('PermissionRequest'),
      tool('PostToolUse'),
      turn('Stop', 10),
      // Codex caps an Interrupt hook at three seconds.
      turn('Interrupt', 3),
    ]);
  });

  it('keeps a path with spaces and quotes one shell word inside a TOML string', () => {
    const [first] = buildCodexHookOverrides(`/My "Data"/it's/hook.sh`);
    expect(first).toContain(`command="/bin/sh '/My \\"Data\\"/it'\\\\''s/hook.sh'"`);
  });
});

describe('buildCodexTrustOverride', () => {
  it('writes one inline table keyed by hook', () => {
    const hooks = [
      { key: '/<session-flags>/config.toml:stop:0:0', hash: 'sha256:aa' },
      { key: '/<session-flags>/config.toml:interrupt:0:0', hash: 'sha256:bb' },
    ];
    expect(buildCodexTrustOverride(hooks)).toBe(
      'hooks.state={"/<session-flags>/config.toml:stop:0:0"={trusted_hash="sha256:aa"},' +
        '"/<session-flags>/config.toml:interrupt:0:0"={trusted_hash="sha256:bb"}}',
    );
  });
});

describe('codexConfigArgs', () => {
  it('passes each override behind its own -c', () => {
    expect(codexConfigArgs(['a=1', 'b=2'])).toEqual(['-c', 'a=1', '-c', 'b=2']);
  });
});

describe('hasCodexHookOverride', () => {
  it('finds a hook flag in either spelling, and nothing in other flags', () => {
    expect(hasCodexHookOverride(['-c', 'hooks.Stop=[]'])).toBe(true);
    expect(hasCodexHookOverride(['--config=hooks.state={}'])).toBe(true);
    expect(hasCodexHookOverride(['-c=hooks.Stop=[]'])).toBe(true);
    expect(hasCodexHookOverride(['-c', 'hooks={Stop=[]}'])).toBe(true);
    expect(hasCodexHookOverride(['-c', 'hooksmith=1'])).toBe(false);
    expect(hasCodexHookOverride(['-c', 'model="x"', 'resume', 'hooks'])).toBe(false);
    expect(hasCodexHookOverride(['-chooks.Stop=[]'])).toBe(true);
    // A prompt handed over as an argument is no flag, whatever it starts with.
    expect(hasCodexHookOverride(['hooks.ts is broken'])).toBe(false);
  });
});

describe('isCodexCommand', () => {
  it('matches codex by name or path, but no wrapper', () => {
    expect(isCodexCommand('codex')).toBe(true);
    expect(isCodexCommand('/opt/bin/codex')).toBe(true);
    expect(isCodexCommand('codex-wrapper')).toBe(false);
    expect(isCodexCommand('claude')).toBe(false);
  });
});
