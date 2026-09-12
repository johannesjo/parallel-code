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

  it('explains that refinement starts from an unaccepted proposal and preserves its other improvements', () => {
    const prompt = buildDocumentPrompt({
      documentPath: 'docs/spec.md',
      scope: { ...scope, wholeDocument: true },
      instruction: 'Clarify the assumptions.',
      refinementInstruction: 'Simplify the architecture.',
    });
    expect(prompt).toContain('unaccepted candidate');
    expect(prompt).toContain('preserving its other improvements');
    expect(prompt).toContain('The earlier instruction was:\nSimplify the architecture.');
    expect(prompt).toContain('Instruction:\nClarify the assumptions.');
  });

  it('shows a merging agent each proposal as a diff with the reviewer notes', () => {
    const prompt = buildDocumentPrompt({
      documentPath: 'docs/spec.md',
      scope: { ...scope, wholeDocument: true },
      instruction: 'Prefer the clearer wording.',
      mergeInstruction: 'Tighten the overview.',
      mergeCandidates: [
        { label: 'A', agentName: 'Claude', diff: '-old\n+new A', summary: 'Shortened it.' },
        { label: 'B', agentName: 'Codex', diff: '-old\n+new B', note: 'Keep the second bullet.' },
      ],
    });
    expect(prompt).toContain('2 candidates proposed changes');
    expect(prompt).toContain('> Tighten the overview.');
    expect(prompt).toContain(
      '### Candidate A (Claude)\nIts own summary: Shortened it.\n```diff\n-old\n+new A\n```',
    );
    expect(prompt).toContain("The reviewer's note on it: Keep the second bullet.");
    expect(prompt).toContain('which parts came from which candidate');
    expect(prompt).toContain('Instruction:\nPrefer the clearer wording.');
    expect(prompt).not.toContain('unaccepted candidate');
  });

  it('keeps a worst-case merge prompt under the Linux argument limit', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      label: 'ABCDEF'[i],
      agentName: 'Agent',
      diff: `-old\n+${'x'.repeat(40_000)}`,
      summary: 's'.repeat(5_000),
      note: 'n'.repeat(5_000),
    }));
    const prompt = buildDocumentPrompt({
      documentPath: 'docs/spec.md',
      scope: { ...scope, wholeDocument: true },
      instruction: 'i'.repeat(20_000),
      mergeInstruction: 'm'.repeat(20_000),
      mergeCandidates: candidates,
    });
    expect(Buffer.byteLength(prompt)).toBeLessThan(128 * 1024);
    // The diff budget is shared: six candidates get 10 000 bytes each, of
    // which the diff header takes six.
    const runs = (prompt.match(/x{100,}/g) ?? []).map((run) => run.length);
    expect(runs).toEqual(Array<number>(6).fill(10_000 - '-old\n+'.length));
    expect(prompt.match(/… \(diff truncated\)/g)).toHaveLength(6);
    expect(prompt).toContain('Instruction:\n' + 'i'.repeat(20_000));
  });

  it('gives two candidates the full single-diff cap and cuts on a character boundary', () => {
    const diff = `-old\n+${'é'.repeat(20_000)}`; // 2 bytes per character
    const prompt = buildDocumentPrompt({
      documentPath: 'docs/spec.md',
      scope: { ...scope, wholeDocument: true },
      instruction: 'Merge.',
      mergeCandidates: [
        { label: 'A', agentName: 'Agent', diff },
        { label: 'B', agentName: 'Agent', diff: '-old\n+short' },
      ],
    });
    // 30 000 bytes of "é" is 15 000 characters: whole ones, no replacement glyph.
    expect(prompt).toMatch(/\+é{14990,}\n… \(diff truncated\)/);
    expect(prompt).not.toContain('\uFFFD');
    expect(prompt).toContain('+short\n```');
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
