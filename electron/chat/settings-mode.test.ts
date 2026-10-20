import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchPermissionMode, settingsDefaultMode } from './settings-mode.js';

let root: string;
let cwd: string;
const write = (dir: string, name: string, contents: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
};
const project = () => join(cwd, '.claude');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-mode-'));
  cwd = join(root, 'worktree');
  mkdirSync(cwd, { recursive: true });
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('settingsDefaultMode', () => {
  it('reads nothing when no settings file sets a mode', async () => {
    await expect(settingsDefaultMode(cwd)).resolves.toBeUndefined();
    write(join(root, 'config'), 'settings.json', '{"permissions":{"allow":["Read"]}}');
    await expect(settingsDefaultMode(cwd)).resolves.toBeUndefined();
  });

  it('lets project settings override user settings, and local override both', async () => {
    write(join(root, 'config'), 'settings.json', '{"permissions":{"defaultMode":"plan"}}');
    await expect(settingsDefaultMode(cwd)).resolves.toBe('plan');
    write(project(), 'settings.json', '{"permissions":{"defaultMode":"default"}}');
    await expect(settingsDefaultMode(cwd)).resolves.toBe('default');
    write(project(), 'settings.local.json', '{"permissions":{"defaultMode":"acceptEdits"}}');
    await expect(settingsDefaultMode(cwd)).resolves.toBe('acceptEdits');
  });

  /** The CLI's own trust rule, measured against 2.1.276: a checkout is someone
   *  else's code, and either of its files can ship in a repository. */
  it('refuses an escalating mode from either file the checkout can carry', async () => {
    write(project(), 'settings.json', '{"permissions":{"defaultMode":"auto"}}');
    await expect(settingsDefaultMode(cwd)).resolves.toBeUndefined();
    write(project(), 'settings.json', '{}');
    write(project(), 'settings.local.json', '{"permissions":{"defaultMode":"auto"}}');
    await expect(settingsDefaultMode(cwd)).resolves.toBeUndefined();
    // Not an escalation, so a file in the checkout may still ask for it.
    write(project(), 'settings.local.json', '{"permissions":{"defaultMode":"plan"}}');
    await expect(settingsDefaultMode(cwd)).resolves.toBe('plan');
  });

  it('takes an escalating mode the user set for themselves', async () => {
    write(join(root, 'config'), 'settings.json', '{"permissions":{"defaultMode":"auto"}}');
    await expect(settingsDefaultMode(cwd)).resolves.toBe('auto');
  });

  it('keeps the readable settings when one file is malformed', async () => {
    write(join(root, 'config'), 'settings.json', '{"permissions":{"defaultMode":"auto"}}');
    write(project(), 'settings.json', '{ not json');
    await expect(settingsDefaultMode(cwd)).resolves.toBe('auto');
  });
});

describe('launchPermissionMode', () => {
  it('passes on the modes a session may launch itself in', () => {
    expect(launchPermissionMode('auto')).toBe('auto');
    expect(launchPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(launchPermissionMode('plan')).toBe('plan');
    expect(launchPermissionMode('dontAsk')).toBe('dontAsk');
    // The command line's name for the asking mode, which the SDK calls 'default'.
    expect(launchPermissionMode('manual')).toBe('default');
  });

  it('adopts neither bypassPermissions nor a mode it does not know', () => {
    expect(launchPermissionMode('bypassPermissions')).toBeUndefined();
    expect(launchPermissionMode('yolo')).toBeUndefined();
    expect(launchPermissionMode(undefined)).toBeUndefined();
  });
});
