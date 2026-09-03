import { describe, expect, it } from 'vitest';
import {
  countOutOfScopeHunks,
  parseCommitBody,
  validateDocumentPath,
  validateSha,
} from './documents.js';

describe('validateDocumentPath', () => {
  it('accepts a relative markdown path and normalizes ./', () => {
    expect(validateDocumentPath('./docs/spec.md')).toBe('docs/spec.md');
  });
  it('rejects traversal, absolute paths and metadata directories', () => {
    expect(() => validateDocumentPath('../x.md')).toThrow();
    expect(() => validateDocumentPath('docs/../x.md')).toThrow();
    expect(() => validateDocumentPath('/abs/x.md')).toThrow();
    expect(() => validateDocumentPath('.parallel/runs/a.json')).toThrow();
    expect(() => validateDocumentPath('.worktrees/x/a.md')).toThrow();
    expect(() => validateDocumentPath('')).toThrow();
    expect(() => validateDocumentPath(3)).toThrow();
  });
});

describe('validateSha', () => {
  it('accepts hex hashes only', () => {
    expect(validateSha('abcdef1')).toBe('abcdef1');
    expect(() => validateSha('HEAD~1')).toThrow();
    expect(() => validateSha('abc')).toThrow();
  });
});

describe('countOutOfScopeHunks', () => {
  const scope = {
    path: 'a.md',
    wholeDocument: false,
    startLine: 10,
    endLine: 20,
    quote: '',
  };
  it('counts nothing for a whole-document scope', () => {
    expect(countOutOfScopeHunks('@@ -1,3 +1,4 @@\n', { ...scope, wholeDocument: true })).toBe(0);
  });
  it('accepts hunks inside or adjacent to the scope', () => {
    const diff = ['@@ -10,3 +10,4 @@', '@@ -19,2 +20,2 @@', '@@ -9 +9 @@', '@@ -21 +22 @@'].join(
      '\n',
    );
    expect(countOutOfScopeHunks(diff, scope)).toBe(0);
  });
  it('flags hunks clearly outside the scope, including pure insertions', () => {
    const diff = ['@@ -2,3 +2,4 @@', '@@ -30,0 +32,2 @@', '@@ -15 +16 @@'].join('\n');
    expect(countOutOfScopeHunks(diff, scope)).toBe(2);
  });
  it('treats an insertion right after the scope as in scope', () => {
    expect(countOutOfScopeHunks('@@ -20,0 +21,3 @@', scope)).toBe(0);
    expect(countOutOfScopeHunks('@@ -22,0 +23,3 @@', scope)).toBe(1);
  });
});

describe('parseCommitBody', () => {
  it('separates prose from Parallel trailers', () => {
    const body =
      'Rewrote the intro.\n\n- shorter\n\nParallel-Run: r1\nParallel-Agent: Claude Code\nParallel-Scope: a.md#L1-L3\n';
    const { text, trailers } = parseCommitBody(body);
    expect(text).toBe('Rewrote the intro.\n\n- shorter');
    expect(trailers).toEqual({ Run: 'r1', Agent: 'Claude Code', Scope: 'a.md#L1-L3' });
  });
  it('returns empty trailers for a manual commit', () => {
    expect(parseCommitBody('just a note').trailers).toEqual({});
  });
});
