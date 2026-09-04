import { describe, expect, it } from 'vitest';
import { createAnchor, relocateAnchor } from './annotation-anchor';
import type { DocumentBlock } from './markdown-blocks';

function blocks(raws: string[], headings: Record<number, string> = {}): DocumentBlock[] {
  let line = 1;
  return raws.map((raw, index) => {
    const startLine = line;
    const endLine = line + raw.split('\n').length - 1;
    line = endLine + 2;
    return {
      index,
      type: headings[index] ? 'heading' : 'paragraph',
      startLine,
      endLine,
      raw: raw + '\n\n',
      html: '',
      headingLevel: headings[index] ? 2 : undefined,
      headingText: headings[index],
    };
  });
}

const doc = blocks(
  ['# Title', 'Intro.', '## A', 'Same text.', 'Tail A.', '## B', 'Same text.', 'Tail B.'],
  {
    0: 'Title',
    2: 'A',
    5: 'B',
  },
);

describe('createAnchor', () => {
  it('captures quote, context and heading', () => {
    const a = createAnchor(doc, 3, 4, 'd.md', 'abc1234');
    expect(a.quote).toBe('Same text.\n\nTail A.');
    expect(a.prefix).toBe('## A');
    expect(a.suffix).toBe('## B');
    expect(a.heading).toBe('A');
    expect(a.startLine).toBe(doc[3].startLine);
    expect(a.endLine).toBe(doc[4].endLine);
  });
});

describe('relocateAnchor', () => {
  it('finds a unique passage at its recorded lines', () => {
    const a = createAnchor(doc, 1, 1, 'd.md', null);
    expect(relocateAnchor(a, doc)).toEqual({ startBlock: 1, endBlock: 1, exact: true });
  });

  it('relocates when text above it changed', () => {
    const a = createAnchor(doc, 4, 4, 'd.md', null);
    const shifted = blocks(
      ['# Title', 'Intro.', 'New paragraph.', '## A', 'Same text.', 'Tail A.', '## B'],
      {
        0: 'Title',
        3: 'A',
        6: 'B',
      },
    );
    expect(relocateAnchor(a, shifted)).toEqual({ startBlock: 5, endBlock: 5, exact: false });
  });

  it('uses surroundings to pick between duplicate passages', () => {
    const a = createAnchor(doc, 6, 6, 'd.md', null); // "Same text." under B
    expect(relocateAnchor(a, doc)).toEqual({ startBlock: 6, endBlock: 6, exact: true });
    // Even when the lines moved, the heading and neighbours still disambiguate.
    const moved = blocks(
      ['## A', 'Same text.', 'Tail A.', 'Extra.', '## B', 'Same text.', 'Tail B.'],
      {
        0: 'A',
        4: 'B',
      },
    );
    expect(relocateAnchor(a, moved)).toEqual({ startBlock: 5, endBlock: 5, exact: false });
  });

  it('detaches when the passage is gone or ambiguous', () => {
    const a = createAnchor(doc, 4, 4, 'd.md', null);
    expect(relocateAnchor(a, blocks(['Other.', 'Text.']))).toBeNull();
    const ambiguous = blocks(['Same.', 'Same.']);
    const b = createAnchor(ambiguous, 0, 0, 'd.md', null);
    // Both copies have identical surroundings after an edit that removed their neighbours.
    expect(
      relocateAnchor({ ...b, prefix: 'x', suffix: 'y', startLine: 99, endLine: 99 }, ambiguous),
    ).toBeNull();
  });

  it('ignores whitespace differences', () => {
    const a = createAnchor(doc, 1, 1, 'd.md', null);
    const reflowed = blocks(['# Title', 'Intro.  ']);
    expect(relocateAnchor(a, reflowed)?.startBlock).toBe(1);
  });
});
