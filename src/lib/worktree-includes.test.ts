import { describe, expect, it } from 'vitest';
import {
  defaultIncludes,
  includeRows,
  resolveIncludeSelection,
  sanitizeWorktreeIncludes,
  sanitizeWorktreeScript,
  splitIncludeSelection,
  withIncludeMode,
} from './worktree-includes';

const entries = [
  { name: 'node_modules', isDefault: true },
  { name: '.env', isDefault: true },
  { name: 'dist', isDefault: false },
];

describe('resolveIncludeSelection', () => {
  it('without a saved list, checks exactly the built-in defaults, all as symlinks', () => {
    const selection = resolveIncludeSelection(entries, undefined);
    expect(selection.dirs).toEqual(['node_modules', '.env', 'dist']);
    expect([...selection.selected]).toEqual(['node_modules', '.env']);
    expect(selection.copy.size).toBe(0);
  });

  it('with a saved list, checks only the saved entries in their saved mode', () => {
    const selection = resolveIncludeSelection(entries, [
      { name: '.env', mode: 'copy' },
      { name: 'dist', mode: 'symlink' },
      { name: 'gone', mode: 'copy' },
    ]);
    expect([...selection.selected].sort()).toEqual(['.env', 'dist']);
    expect([...selection.copy]).toEqual(['.env']);
  });

  it('treats an empty saved list as "bring nothing in"', () => {
    expect(resolveIncludeSelection(entries, []).selected.size).toBe(0);
  });
});

describe('splitIncludeSelection', () => {
  it('splits checked names into symlink and copy lists, dropping unchecked copies', () => {
    expect(
      splitIncludeSelection(new Set(['node_modules', '.env']), new Set(['.env', 'dist'])),
    ).toEqual({ symlinkDirs: ['node_modules'], copyDirs: ['.env'] });
  });
});

describe('sanitizeWorktreeIncludes', () => {
  it('keeps unset as unset and an empty list as empty', () => {
    expect(sanitizeWorktreeIncludes(undefined)).toBeUndefined();
    expect(sanitizeWorktreeIncludes('node_modules')).toBeUndefined();
    expect(sanitizeWorktreeIncludes([])).toEqual([]);
  });

  it('drops invalid names, unknown modes and duplicates', () => {
    expect(
      sanitizeWorktreeIncludes([
        { name: '.env', mode: 'copy' },
        { name: '.env', mode: 'symlink' },
        { name: '../up', mode: 'copy' },
        { name: 'a/b', mode: 'copy' },
        { name: 'bad\nline', mode: 'symlink' },
        { name: 'dist', mode: 'hardlink' },
        null,
        { name: 'node_modules', mode: 'symlink' },
      ]),
    ).toEqual([
      { name: '.env', mode: 'copy' },
      { name: 'node_modules', mode: 'symlink' },
    ]);
  });
});

describe('sanitizeWorktreeScript', () => {
  it('drops blank and non-string scripts', () => {
    expect(sanitizeWorktreeScript('  ')).toBeUndefined();
    expect(sanitizeWorktreeScript(3)).toBeUndefined();
    expect(sanitizeWorktreeScript('npm ci')).toBe('npm ci');
  });
});

describe('settings editor helpers', () => {
  it('seeds a new list from the defaults', () => {
    expect(defaultIncludes(entries)).toEqual([
      { name: 'node_modules', mode: 'symlink' },
      { name: '.env', mode: 'symlink' },
    ]);
  });

  it('lists candidates first and flags saved names the checkout lacks', () => {
    expect(
      includeRows(entries, [
        { name: 'gone', mode: 'copy' },
        { name: 'dist', mode: 'copy' },
      ]),
    ).toEqual([
      { name: 'node_modules', mode: null, present: true },
      { name: '.env', mode: null, present: true },
      { name: 'dist', mode: 'copy', present: true },
      { name: 'gone', mode: 'copy', present: false },
    ]);
  });

  it('changes, adds and removes one entry', () => {
    const saved = [
      { name: 'node_modules', mode: 'symlink' as const },
      { name: '.env', mode: 'symlink' as const },
    ];
    expect(withIncludeMode(saved, '.env', 'copy')).toEqual([
      { name: 'node_modules', mode: 'symlink' },
      { name: '.env', mode: 'copy' },
    ]);
    expect(withIncludeMode(saved, 'dist', 'symlink')).toHaveLength(3);
    expect(withIncludeMode(saved, 'node_modules', null)).toEqual([
      { name: '.env', mode: 'symlink' },
    ]);
  });
});
