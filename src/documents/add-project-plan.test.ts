import { describe, expect, it } from 'vitest';
import { folderName, guessProjectKind, joinFolderPath, quickEditRepo } from './add-project-plan';
import type { DocumentFolderInfo } from './types';

function info(fields: Partial<DocumentFolderInfo>): DocumentFolderInfo {
  return {
    exists: true,
    isRepo: false,
    enclosingRepo: null,
    hasCommits: false,
    looksLikeCode: false,
    files: [],
    ...fields,
  };
}

describe('guessProjectKind', () => {
  it('reads a folder with code as a code project', () => {
    expect(guessProjectKind(info({ isRepo: true, looksLikeCode: true }))).toBe('code');
  });

  it('reads writing, empty and not-yet-made folders as documents', () => {
    expect(guessProjectKind(info({ files: [{ path: 'a.md', committed: true }] }))).toBe('document');
    expect(guessProjectKind(info({}))).toBe('document');
    expect(guessProjectKind(info({ exists: false }))).toBe('document');
    expect(guessProjectKind(null)).toBe('document');
  });
});

describe('quickEditRepo', () => {
  it('names the enclosing repository of a docs subfolder', () => {
    expect(quickEditRepo('/repo/docs', info({ enclosingRepo: '/repo' }))).toBe('/repo');
  });

  it('names a code folder itself, repository or not', () => {
    expect(quickEditRepo('/scripts', info({ looksLikeCode: true }))).toBe('/scripts');
    expect(quickEditRepo('/repo', info({ isRepo: true, looksLikeCode: true }))).toBe('/repo');
  });

  it('leaves writing repositories and plain folders as projects', () => {
    expect(quickEditRepo('/notes', info({ isRepo: true }))).toBeNull();
    expect(quickEditRepo('/x', undefined)).toBeNull();
  });
});

it('joins a folder and a relative file once', () => {
  expect(joinFolderPath('/repo/docs/', 'spec.md')).toBe('/repo/docs/spec.md');
});

it('names a project after the last folder of its path', () => {
  expect(folderName('/notes/design/')).toBe('design');
  expect(folderName('/')).toBe('/');
});
