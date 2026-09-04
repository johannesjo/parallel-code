import { describe, expect, it } from 'vitest';
import {
  countOutOfScopeHunks,
  parseCommitBody,
  sanitizeRunRecord,
  validateDocumentPath,
  validateSha,
} from './runs.js';

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
    expect(() => validateDocumentPath('.git/config')).toThrow();
    expect(validateDocumentPath('.github/README.md')).toBe('.github/README.md');
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
  it('ignores trailer-shaped lines outside the final paragraph', () => {
    const body =
      'Prose.\nParallel-Agent: Human\n\n- more\n\nParallel-Run: r1\nParallel-Agent: Codex';
    const { text, trailers } = parseCommitBody(body);
    expect(trailers.Agent).toBe('Codex');
    expect(text).toContain('Parallel-Agent: Human');
  });
  it('treats a mixed last paragraph as prose', () => {
    expect(parseCommitBody('Parallel-Agent: X\nnot a trailer').trailers).toEqual({});
  });
});

describe('sanitizeRunRecord', () => {
  const root = '/repo';
  const good = {
    version: 1,
    id: 'run-1',
    documentPath: 'docs/a.md',
    baseSha: 'abcdef1234567',
    status: 'finished',
    createdAt: 'x',
    instruction: 'i',
    scope: { path: 'docs/a.md', wholeDocument: true, startLine: 1, endLine: 1, quote: '' },
    candidates: [
      {
        id: 'c1',
        label: 'A',
        agentId: 'claude-code',
        agentName: 'Claude',
        isMain: false,
        branch: 'parallel-doc/abc-a',
        worktreePath: '/repo/.worktrees/parallel-doc/abc-a',
        status: 'done',
        commitSha: 'abcdef1234567',
        startedAt: 'x',
      },
    ],
  };
  it('accepts a record this app would have written', () => {
    expect(sanitizeRunRecord(root, good)).not.toBeNull();
  });
  it('rejects a worktree path outside .worktrees', () => {
    const bad = {
      ...good,
      candidates: [{ ...good.candidates[0], worktreePath: '/home/me/Documents' }],
    };
    expect(sanitizeRunRecord(root, bad)).toBeNull();
    const sneaky = {
      ...good,
      candidates: [{ ...good.candidates[0], worktreePath: '/repo/.worktrees/../../etc' }],
    };
    expect(sanitizeRunRecord(root, sneaky)).toBeNull();
  });
  it('rejects foreign branch names and bad shas', () => {
    expect(
      sanitizeRunRecord(root, { ...good, candidates: [{ ...good.candidates[0], branch: 'main' }] }),
    ).toBeNull();
    expect(
      sanitizeRunRecord(root, {
        ...good,
        candidates: [{ ...good.candidates[0], commitSha: '--output=x' }],
      }),
    ).toBeNull();
    expect(sanitizeRunRecord(root, { ...good, baseSha: 'HEAD' })).toBeNull();
  });
});
