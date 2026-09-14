import { describe, expect, it } from 'vitest';
import { buildClaudeHookSettings } from './claude-settings.js';

describe('buildClaudeHookSettings', () => {
  const settings = buildClaudeHookSettings('/Users/me/Library/App Support/hook.sh', 'darwin');

  it('registers turn, tool, and notification events', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual(
      [
        'Notification',
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'StopFailure',
        'UserPromptSubmit',
      ].sort(),
    );
  });

  it('matches every tool and only the blocking notification types', () => {
    expect(settings.hooks.PreToolUse[0].matcher).toBe('*');
    expect(settings.hooks.PermissionRequest[0].matcher).toBe('*');
    expect(settings.hooks.Stop[0].matcher).toBeUndefined();
    expect(settings.hooks.Notification[0].matcher).toBe(
      'permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog',
    );
  });

  it('runs the script through /bin/sh with the path quoted and a short timeout', () => {
    const hook = settings.hooks.Stop[0].hooks[0];
    expect(hook).toEqual({
      type: 'command',
      command: "/bin/sh '/Users/me/Library/App Support/hook.sh'",
      timeout: 10,
    });
  });

  it('uses PowerShell for hooks on native Windows', () => {
    const hook = buildClaudeHookSettings('C:\\Program Files\\Parallel Code\\hook.ps1', 'win32')
      .hooks.Stop[0].hooks[0];
    expect(hook.command).toBe(
      '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\Program Files\\Parallel Code\\hook.ps1"',
    );
  });

  it('does not register compaction hooks, which fire mid-turn', () => {
    expect(settings.hooks.PreCompact).toBeUndefined();
    expect(settings.hooks.PostCompact).toBeUndefined();
  });
});
