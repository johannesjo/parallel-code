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

describe('relocateAnchor with blank lines inside a block', () => {
  // A loose list keeps its blank line in `raw`, so the quote has more
  // paragraphs than the passage has blocks.
  const loose = blocks(['Intro.', '- one\n\n- two', 'Tail.']);

  it('finds a passage whose own text contains a blank line', () => {
    const anchor = createAnchor(loose, 1, 1, 'notes.md', null);
    expect(relocateAnchor(anchor, loose)).toEqual({ startBlock: 1, endBlock: 1, exact: true });
  });

  it('still finds it after the lines above it moved', () => {
    const anchor = createAnchor(loose, 1, 1, 'notes.md', null);
    const moved = blocks(['Intro.', 'A new paragraph.', '- one\n\n- two', 'Tail.']);
    expect(relocateAnchor(anchor, moved)).toEqual({ startBlock: 2, endBlock: 2, exact: false });
  });
});

describe('relocateAnchor after the passage was reworded', () => {
  // An accepted proposal rewrites the passage a note hangs on. Exact matching
  // orphans the note; this is the case the product produces by design.
  const before = blocks(['# Title', 'Intro.', '## A', 'The old goals text is vague and long.']);

  it('follows a passage an agent sharpened', () => {
    const a = createAnchor(before, 3, 3, 'd.md', null);
    const after = blocks(['# Title', 'Intro.', '## A', 'The old goals text is vague and terse.']);
    expect(relocateAnchor(a, after)).toEqual({ startBlock: 3, endBlock: 3, exact: true });
  });

  it('follows it when the lines moved too', () => {
    const a = createAnchor(before, 3, 3, 'd.md', null);
    const after = blocks([
      '# Title',
      'Intro.',
      'A new paragraph.',
      '## A',
      'The old goals text is vague and terse.',
    ]);
    expect(relocateAnchor(a, after)).toEqual({ startBlock: 4, endBlock: 4, exact: false });
  });

  it('stays detached when the passage was replaced outright', () => {
    const a = createAnchor(before, 3, 3, 'd.md', null);
    const after = blocks(['# Title', 'Intro.', '## A', 'Ship the thing by Friday.']);
    expect(relocateAnchor(a, after)).toBeNull();
  });

  it('stays detached when two passages are equally close', () => {
    const source = blocks(['One two three four five.', 'One two three four six.']);
    const a = createAnchor(source, 0, 0, 'd.md', null);
    const after = blocks(['One two three four seven.', 'One two three four eight.']);
    expect(relocateAnchor(a, after)).toBeNull();
  });

  it('prefers an exact match over a similar neighbour', () => {
    const source = blocks(['Intro.', 'The goals are vague and long.', 'The goals are vague too.']);
    const a = createAnchor(source, 2, 2, 'd.md', null);
    expect(relocateAnchor(a, source)).toEqual({ startBlock: 2, endBlock: 2, exact: true });
  });
});

describe('relocateAnchor and parallel passages', () => {
  // The worst failure: the annotated passage is deleted and a sibling worded
  // almost the same survives. Similarity alone hands the note to the sibling.
  const api = blocks([
    '# API',
    'The API returns a list of users.',
    'The API returns a list of groups.',
  ]);

  it('stays detached when the passage is deleted and its sibling survives', () => {
    const a = createAnchor(api, 1, 1, 'api.md', null);
    const after = blocks(['# API', 'The API returns a list of groups.']);
    expect(relocateAnchor(a, after)).toBeNull();
  });

  it('still follows a rewording when the neighbour it recorded is still there', () => {
    const a = createAnchor(api, 1, 1, 'api.md', null);
    const after = blocks([
      '# API',
      'The API returns a list of active users.',
      'The API returns a list of groups.',
    ]);
    // Its recorded lines still hold, so this counts as found where it was.
    expect(relocateAnchor(a, after)).toEqual({ startBlock: 1, endBlock: 1, exact: true });
  });
});

describe('relocateAnchor across section boundaries', () => {
  // The residual gap the parallel-passage rule left open: the note's whole
  // section is dropped, and the sibling section that survives is worded almost
  // identically. Nothing in the surviving text says it is not the passage.
  const sections = blocks(
    [
      '# API',
      '## Users',
      'The API returns a paginated list of items for the current account.',
      '## Groups',
      'The API returns a paginated list of items for the current team.',
    ],
    { 1: 'Users', 3: 'Groups' },
  );
  const onUsers = createAnchor(sections, 2, 2, 'api.md', null);

  it('stays detached when a section is dropped and its twin survives', () => {
    const after = blocks(
      ['# API', '## Groups', 'The API returns a paginated list of items for the current team.'],
      { 1: 'Groups' },
    );
    expect(relocateAnchor(onUsers, after)).toBeNull();
  });

  it('still follows the passage when its own section is only reworded', () => {
    const after = blocks(
      [
        '# API',
        '## Users',
        'The API returns a paginated list of items for the signed-in account.',
        '## Groups',
        'The API returns a paginated list of items for the current team.',
      ],
      { 1: 'Users', 3: 'Groups' },
    );
    expect(relocateAnchor(onUsers, after)).toEqual({ startBlock: 2, endBlock: 2, exact: true });
  });

  it('follows the passage when its section moved below its twin', () => {
    // The boundary is about which side of the recorded neighbours a run sits
    // on, not about position in the file: reordered sections still resolve.
    const after = blocks(
      [
        '# API',
        '## Groups',
        'The API returns a paginated list of items for the current team.',
        '## Users',
        'The API returns a paginated list of items for the signed-in account.',
      ],
      { 1: 'Groups', 3: 'Users' },
    );
    expect(relocateAnchor(onUsers, after)).toEqual({ startBlock: 4, endBlock: 4, exact: false });
  });
});
