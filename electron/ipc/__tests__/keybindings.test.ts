import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadKeybindings, saveKeybindings } from '../keybindings.js';

describe('keybindings persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keybindings-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default config when file does not exist', () => {
    const result = loadKeybindings(tmpDir);
    expect(result).toEqual({ preset: 'default', overridesByPreset: {} });
  });

  it('saves and loads a keybinding config', () => {
    const config = {
      preset: 'claude-code',
      overridesByPreset: {
        'claude-code': {
          'app.toggle-sidebar': { key: 'b', modifiers: { cmdOrCtrl: true, shift: true } },
        },
      },
    };
    saveKeybindings(tmpDir, JSON.stringify(config));
    const loaded = loadKeybindings(tmpDir);
    expect(loaded).toEqual(config);
  });

  it('falls back to default on corrupted file', () => {
    fs.writeFileSync(path.join(tmpDir, 'keybindings.json'), 'not json', 'utf8');
    const result = loadKeybindings(tmpDir);
    expect(result).toEqual({ preset: 'default', overridesByPreset: {} });
  });

  it('falls back to backup on corrupted primary', () => {
    const config = { preset: 'claude-code', overridesByPreset: {} };
    fs.writeFileSync(path.join(tmpDir, 'keybindings.json'), 'corrupted', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'keybindings.json.bak'), JSON.stringify(config), 'utf8');
    const result = loadKeybindings(tmpDir);
    expect(result).toEqual(config);
  });

  it('accepts legacy flat userOverrides format', () => {
    const legacy = {
      preset: 'claude-code',
      userOverrides: {
        'app.toggle-sidebar': { key: 'b', modifiers: { cmdOrCtrl: true, shift: true } },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'keybindings.json'), JSON.stringify(legacy), 'utf8');
    const loaded = loadKeybindings(tmpDir);
    expect(loaded.preset).toBe('claude-code');
    expect(loaded.userOverrides).toEqual(legacy.userOverrides);
  });
});
