import { describe, expect, it } from 'vitest';
import { buildCanvasReference, headingAbove } from './canvas-reference';

const source = [
  '# Design',
  '',
  'Intro paragraph.',
  '',
  '## Storage',
  '',
  '- We keep **state** in a [store](./store.md).',
  '- Writes are batched.',
  '',
  'Closing words.',
].join('\n');

describe('headingAbove', () => {
  it('reports the nearest heading above a line, the line itself included', () => {
    expect(headingAbove(source, 7)).toBe('Storage');
    expect(headingAbove(source, 5)).toBe('Storage');
    expect(headingAbove(source, 3)).toBe('Design');
  });

  it('is undefined before the first heading and in plain text', () => {
    expect(headingAbove('plain text', 1)).toBeUndefined();
    expect(headingAbove('\n\n# Late', 1)).toBeUndefined();
  });
});

describe('buildCanvasReference', () => {
  it('puts the instruction first, then document, scope and the quoted passage', () => {
    const text = buildCanvasReference({
      documentPath: 'docs/design.md',
      quote: 'Writes are batched.',
      instruction: 'Explain why.',
      location: { startLine: 8, endLine: 8, heading: 'Storage' },
    });
    expect(text).toBe(
      [
        'Explain why.',
        'Document: docs/design.md',
        'Scope: lines 8-8 (under "Storage").',
        'The passage, verbatim:\n> Writes are batched.',
      ].join('\n\n'),
    );
  });

  it('omits the scope when the passage cannot be placed and strips control characters', () => {
    const text = buildCanvasReference({
      documentPath: 'a.md',
      quote: 'gone\x1b[31m line\r',
      instruction: '',
      location: null,
    });
    expect(text).toBe('Document: a.md\n\nThe passage, verbatim:\n> gone[31m line');
  });
});
