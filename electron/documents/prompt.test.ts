import { describe, expect, it } from 'vitest';
import { buildDocumentPrompt, parseDocumentRationale } from './prompt.js';

const scope = {
  path: 'docs/spec.md',
  wholeDocument: false,
  startLine: 10,
  endLine: 12,
  quote: 'First line\nSecond line',
  heading: 'Overview',
};

describe('buildDocumentPrompt', () => {
  it('quotes the scoped passage and names the file', () => {
    const prompt = buildDocumentPrompt({
      documentPath: 'docs/spec.md',
      scope,
      instruction: 'Tighten this.',
    });
    expect(prompt).toContain('Document: docs/spec.md');
    expect(prompt).toContain('lines 10-12 (under "Overview")');
    expect(prompt).toContain('> First line\n> Second line');
    expect(prompt).toContain('Instruction:\nTighten this.');
    expect(prompt).toContain('```json');
    expect(prompt).not.toContain('Since your previous turn');
  });

  it('describes a whole-document scope', () => {
    const prompt = buildDocumentPrompt({
      documentPath: 'docs/spec.md',
      scope: { ...scope, wholeDocument: true },
      instruction: 'Review.',
    });
    expect(prompt).toContain('Scope: the whole document.');
    expect(prompt).not.toContain('verbatim');
  });

  it('hands a resumed session the diff since it last saw the document', () => {
    const prompt = buildDocumentPrompt({
      documentPath: 'docs/spec.md',
      scope,
      instruction: 'Go on.',
      catchUpDiff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
    });
    expect(prompt).toContain('Since your previous turn');
    expect(prompt).toContain('+new');
  });

  it('truncates an oversized catch-up diff', () => {
    const prompt = buildDocumentPrompt({
      documentPath: 'docs/spec.md',
      scope,
      instruction: 'Go on.',
      catchUpDiff: 'x'.repeat(30_000),
    });
    expect(prompt).toContain('(diff truncated)');
    expect(prompt.length).toBeLessThan(25_000);
  });
});

describe('parseDocumentRationale', () => {
  it('takes the last fenced json block', () => {
    const text =
      'Some prose.\n```json\n{"summary": "early"}\n```\nMore.\n```json\n{"summary": "final", "changes": ["a", "b"], "questions": ["q"]}\n```';
    const r = parseDocumentRationale(text);
    expect(r.summary).toBe('final');
    expect(r.changes).toEqual(['a', 'b']);
    expect(r.questions).toEqual(['q']);
    expect(r.assumptions).toEqual([]);
  });

  it('accepts an unlabeled fence and drops non-string entries', () => {
    const r = parseDocumentRationale('```\n{"summary":"s","changes":["ok", 3, ""]}\n```');
    expect(r.summary).toBe('s');
    expect(r.changes).toEqual(['ok']);
  });

  it('parses bare json', () => {
    expect(parseDocumentRationale('{"summary":"bare"}').summary).toBe('bare');
  });

  it('falls back to the first line of prose', () => {
    const r = parseDocumentRationale('\n\nI rewrote the intro.\nDetails follow.');
    expect(r.summary).toBe('I rewrote the intro.');
    expect(r.warnings).toEqual([]);
  });

  it('flags an empty result', () => {
    const r = parseDocumentRationale('   ');
    expect(r.summary).toBe('No rationale returned.');
    expect(r.warnings).toHaveLength(1);
  });

  it('ignores a fence that is valid json but not a rationale', () => {
    const r = parseDocumentRationale('```json\n[1,2]\n```\nSummary line');
    expect(r.summary).toBe('Summary line');
  });
});
