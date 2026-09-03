import { describe, expect, it, vi } from 'vitest';

vi.mock('./shiki-highlighter', () => ({
  highlightLines: async (code: string) => code.split('\n').map((l) => `<span>${l}</span>`),
}));
// DOMPurify needs a DOM; sanitization itself is its job, not this module's.
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

import {
  blockRangeText,
  diffBlocks,
  nearestHeading,
  renderDocumentBlocks,
  sectionRange,
  type DocumentBlock,
} from './markdown-blocks';

const doc = [
  '# Title',
  '',
  'First paragraph',
  'continues here.',
  '',
  '',
  '## Section A',
  '',
  '- one',
  '- two',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '### Sub',
  '',
  'Deep text.',
  '',
  '## Section B',
  '',
  'Last.',
].join('\n');

describe('renderDocumentBlocks', () => {
  it('maps every block to its source lines', async () => {
    const blocks = await renderDocumentBlocks(doc);
    const summary = blocks.map((b) => [b.type, b.startLine, b.endLine]);
    expect(summary).toEqual([
      ['heading', 1, 1],
      ['paragraph', 3, 4],
      ['heading', 7, 7],
      ['list', 9, 10],
      ['code', 12, 14],
      ['heading', 16, 16],
      ['paragraph', 18, 18],
      ['heading', 20, 20],
      ['paragraph', 22, 22],
    ]);
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[0].headingText).toBe('Title');
    expect(blocks[1].html).toContain('<p>');
    expect(blocks[4].html).toContain('shiki-block');
    expect(blocks[4].html).toContain('data-lang="ts"');
  });

  it('handles CRLF sources', async () => {
    const blocks = await renderDocumentBlocks('# A\r\n\r\nmiddle\r\n\r\nB');
    expect(blocks.map((b) => b.startLine)).toEqual([1, 3, 5]);
  });

  it('renders mermaid fences as placeholders', async () => {
    const blocks = await renderDocumentBlocks('```mermaid\ngraph TD; A-->B\n```');
    expect(blocks[0].html).toContain('mermaid-block');
    expect(blocks[0].html).toContain('data-mermaid');
  });
});

describe('sectionRange and nearestHeading', () => {
  it('spans a heading through its subsections', async () => {
    const blocks = await renderDocumentBlocks(doc);
    expect(sectionRange(blocks, 2)).toEqual([2, 6]); // Section A up to Section B
    expect(sectionRange(blocks, 5)).toEqual([5, 6]); // Sub
    expect(sectionRange(blocks, 7)).toEqual([7, 8]);
    expect(sectionRange(blocks, 1)).toEqual([1, 1]); // not a heading
    expect(nearestHeading(blocks, 4)).toBe('Section A');
    expect(nearestHeading(blocks, 0)).toBe('Title');
  });
});

function fake(raws: string[]): DocumentBlock[] {
  return raws.map((raw, index) => ({
    index,
    type: 'paragraph',
    startLine: index + 1,
    endLine: index + 1,
    raw,
    html: '',
  }));
}

describe('diffBlocks', () => {
  it('marks identical documents as unchanged', () => {
    const r = diffBlocks(fake(['a', 'b']), fake(['a', 'b']));
    expect(r.base).toEqual(['same', 'same']);
    expect(r.candidate).toEqual(['same', 'same']);
  });

  it('pairs a rewritten block as changed and a new one as added', () => {
    const r = diffBlocks(fake(['a', 'b', 'c']), fake(['a', 'B!', 'c', 'd']));
    expect(r.base).toEqual(['same', 'changed', 'same']);
    expect(r.candidate).toEqual(['same', 'changed', 'same', 'added']);
  });

  it('marks a deleted block as removed', () => {
    const r = diffBlocks(fake(['a', 'b', 'c']), fake(['a', 'c']));
    expect(r.base).toEqual(['same', 'removed', 'same']);
    expect(r.candidate).toEqual(['same', 'same']);
  });

  it('ignores whitespace-only differences', () => {
    const r = diffBlocks(fake(['a  b\n']), fake(['a b']));
    expect(r.candidate).toEqual(['same']);
  });
});

describe('blockRangeText', () => {
  it('joins raw blocks without trailing newlines', () => {
    expect(blockRangeText(fake(['x\n\n', 'y\n']), 0, 1)).toBe('x\n\ny');
  });
});
