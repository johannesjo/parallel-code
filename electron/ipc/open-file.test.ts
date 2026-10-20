import { describe, expect, it } from 'vitest';
import { editorGotoArgs, validateEditorCommand } from './open-file.js';

describe('editorGotoArgs', () => {
  it('uses --goto for VS Code family editors, including absolute commands', () => {
    expect(editorGotoArgs('code', '/w/src/a.ts', 12)).toEqual(['--goto', '/w/src/a.ts:12']);
    expect(editorGotoArgs('/usr/local/bin/cursor', '/w/a.ts', 3)).toEqual(['--goto', '/w/a.ts:3']);
  });

  it('passes path:line as the only argument for zed and subl', () => {
    expect(editorGotoArgs('zed', '/w/a.ts', 7)).toEqual(['/w/a.ts:7']);
    expect(editorGotoArgs('subl', '/w/a.ts', 7)).toEqual(['/w/a.ts:7']);
  });

  it('returns null for editors whose line syntax is unknown', () => {
    expect(editorGotoArgs('vim', '/w/a.ts', 7)).toBeNull();
  });
});

describe('validateEditorCommand', () => {
  it('trims a plain command', () => {
    expect(validateEditorCommand('  code ')).toBe('code');
  });

  it('rejects empty values and shell metacharacters', () => {
    expect(() => validateEditorCommand('')).toThrow('non-empty');
    expect(() => validateEditorCommand(42)).toThrow('non-empty');
    expect(() => validateEditorCommand('code; rm -rf /')).toThrow('metacharacters');
  });
});
