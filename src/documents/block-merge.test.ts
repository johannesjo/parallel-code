import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/shiki-highlighter', () => ({
  highlightLines: async (code: string) => code.split('\n').map((l) => `<span>${l}</span>`),
}));
// DOMPurify needs a DOM; sanitization is markdown-blocks' concern, not this module's.
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

import { diffBlocks, renderDocumentBlocks, type DocumentBlock } from './markdown-blocks';
import {
  blockHunks,
  composeAcceptedDocument,
  composeVerifiedDocument,
  expectedBlockKeys,
  hunkKind,
  hunkLabel,
  hunkLeadBlocks,
  type BlockHunk,
} from './block-merge';

async function pair(baseSource: string, candidateSource: string) {
  const baseBlocks = await renderDocumentBlocks(baseSource);
  const candidateBlocks = await renderDocumentBlocks(candidateSource);
  const hunks = blockHunks(diffBlocks(baseBlocks, candidateBlocks));
  return { baseSource, baseBlocks, candidateSource, candidateBlocks, hunks };
}

function compose(
  parts: Awaited<ReturnType<typeof pair>>,
  accepted: readonly number[],
): string | null {
  return composeAcceptedDocument({ ...parts, accepted: new Set(accepted) });
}

const BASE = ['# Title', '', 'One.', '', 'Two.', '', 'Three.', ''].join('\n');

describe('blockHunks', () => {
  it('pairs each rewritten run of base blocks with the candidate run replacing it', async () => {
    const { hunks } = await pair(
      BASE,
      ['# Title', '', 'One!', '', 'Two.', '', 'Three!', ''].join('\n'),
    );
    expect(hunks).toEqual<BlockHunk[]>([
      { id: 0, baseStart: 1, baseEnd: 2, candStart: 1, candEnd: 2 },
      { id: 1, baseStart: 3, baseEnd: 4, candStart: 3, candEnd: 4 },
    ]);
    expect(hunks.map(hunkKind)).toEqual(['rewrite', 'rewrite']);
  });

  it('reports an insertion as an empty base run and a deletion as an empty candidate run', async () => {
    const inserted = await pair(
      BASE,
      ['# Title', '', 'One.', '', 'New.', '', 'Two.', '', 'Three.', ''].join('\n'),
    );
    expect(inserted.hunks.map(hunkKind)).toEqual(['insertion']);
    const deleted = await pair(BASE, ['# Title', '', 'One.', '', 'Three.', ''].join('\n'));
    expect(deleted.hunks.map(hunkKind)).toEqual(['deletion']);
  });
});

describe('composeAcceptedDocument', () => {
  it('returns the base unchanged when every hunk is declined', async () => {
    const parts = await pair(
      BASE,
      ['# Title', '', 'One!', '', 'Two!', '', 'Three!', ''].join('\n'),
    );
    expect(compose(parts, [])).toBe(BASE);
  });

  it('returns the candidate when every hunk is kept', async () => {
    const candidate = ['# Title', '', 'One!', '', 'Two!', '', 'Three!', ''].join('\n');
    const parts = await pair(BASE, candidate);
    expect(compose(parts, [0, 1, 2])).toBe(candidate);
  });

  it('takes only the hunks that were kept', async () => {
    const parts = await pair(
      BASE,
      ['# Title', '', 'One!', '', 'Two.', '', 'Three!', ''].join('\n'),
    );
    expect(parts.hunks).toHaveLength(2);
    expect(compose(parts, [1])).toBe(
      ['# Title', '', 'One.', '', 'Two.', '', 'Three!', ''].join('\n'),
    );
    expect(compose(parts, [0])).toBe(
      ['# Title', '', 'One!', '', 'Two.', '', 'Three.', ''].join('\n'),
    );
  });

  it('drops a deleted paragraph without leaving a hole, and restores it when declined', async () => {
    const parts = await pair(BASE, ['# Title', '', 'One.', '', 'Three.', ''].join('\n'));
    expect(compose(parts, [0])).toBe(['# Title', '', 'One.', '', 'Three.', ''].join('\n'));
    expect(compose(parts, [])).toBe(BASE);
  });

  it('drops a deleted last paragraph without leaving a hole', async () => {
    const parts = await pair(BASE, ['# Title', '', 'One.', '', 'Two.', ''].join('\n'));
    expect(parts.hunks.map(hunkKind)).toEqual(['deletion']);
    expect(compose(parts, [0])).toBe(['# Title', '', 'One.', '', 'Two.', ''].join('\n'));
  });

  it('separates an inserted paragraph from its neighbours', async () => {
    const parts = await pair(
      BASE,
      ['# Title', '', 'One.', '', 'New.', '', 'Two.', '', 'Three.', ''].join('\n'),
    );
    expect(compose(parts, [0])).toBe(
      ['# Title', '', 'One.', '', 'New.', '', 'Two.', '', 'Three.', ''].join('\n'),
    );
  });

  it('appends a paragraph added at the end', async () => {
    const parts = await pair(BASE, [...BASE.split('\n').slice(0, -1), '', 'Four.', ''].join('\n'));
    expect(parts.hunks.map(hunkKind)).toEqual(['insertion']);
    expect(compose(parts, [0])).toContain('Three.\n\nFour.');
  });

  it('keeps the base line endings', async () => {
    const crlfBase = BASE.replace(/\n/g, '\r\n');
    const parts = await pair(
      crlfBase,
      ['# Title', '', 'One!', '', 'Two.', '', 'Three.', ''].join('\n'),
    );
    expect(compose(parts, [0])).toBe(
      ['# Title', '', 'One!', '', 'Two.', '', 'Three.', ''].join('\r\n'),
    );
  });

  it('refuses an insertion whose anchor block drifted, instead of appending it', async () => {
    const parts = await pair(
      BASE,
      ['# Title', '', 'One.', '', 'Inserted.', '', 'Two.', '', 'Three.', ''].join('\n'),
    );
    expect(parts.hunks.map(hunkKind)).toEqual(['insertion']);
    const drifted = parts.baseBlocks.map((b, i) =>
      i === 2 ? { ...b, startOffset: (b.startOffset ?? 0) + 1 } : b,
    );
    expect(
      composeAcceptedDocument({ ...parts, baseBlocks: drifted, accepted: new Set([0]) }),
    ).toBeNull();
  });

  it('refuses to compose when a block no longer matches its recorded offsets', async () => {
    const parts = await pair(
      BASE,
      ['# Title', '', 'One!', '', 'Two.', '', 'Three.', ''].join('\n'),
    );
    const drifted: DocumentBlock[] = parts.baseBlocks.map((b, i) =>
      i === 1 ? { ...b, startOffset: (b.startOffset ?? 0) + 3 } : b,
    );
    expect(
      composeAcceptedDocument({ ...parts, baseBlocks: drifted, accepted: new Set([0]) }),
    ).toBeNull();
  });
});

describe('hunkLeadBlocks', () => {
  it('gives each hunk the block its toggle sits on', async () => {
    const { hunks, candidateBlocks } = await pair(
      BASE,
      ['# Title', '', 'One!', '', 'Two.', '', 'Three!', ''].join('\n'),
    );
    const leads = hunkLeadBlocks(hunks, candidateBlocks.length);
    expect([...(leads?.keys() ?? [])]).toEqual([1, 3]);
  });

  it('hangs a deletion on the block that follows it', async () => {
    const { hunks, candidateBlocks } = await pair(
      BASE,
      ['# Title', '', 'One.', '', 'Three.', ''].join('\n'),
    );
    const leads = hunkLeadBlocks(hunks, candidateBlocks.length);
    expect([...(leads?.keys() ?? [])]).toEqual([2]);
  });

  // Two deletions, the second ending the document, both want the last block.
  // Dropping one would leave a change with no way to decline it.
  it('stacks two deletions that land on the same block', async () => {
    const parts = await pair(BASE, ['# Title', '', 'Two.', ''].join('\n'));
    expect(parts.hunks.map(hunkKind)).toEqual(['deletion', 'deletion']);
    const leads = hunkLeadBlocks(parts.hunks, parts.candidateBlocks.length);
    expect([...(leads?.values() ?? [])].flat().map((h) => h.id)).toEqual([0, 1]);
    // Both remain declinable, and declining both restores the base.
    expect(compose(parts, [])).toBe(BASE);
    expect(compose(parts, [0, 1])).toBe(['# Title', '', 'Two.', ''].join('\n'));
  });

  it('refuses when a hunk has nowhere to hang its toggle', () => {
    expect(
      hunkLeadBlocks([{ id: 0, baseStart: 0, baseEnd: 1, candStart: 0, candEnd: 0 }], 0),
    ).toBeNull();
  });
});

describe('splicing into a single-newline seam', () => {
  // A heading and its paragraph sit on consecutive lines. Replacing the
  // heading with a list used to fuse the paragraph into the last bullet.
  const seamBase = ['# Doc', '', '## Open questions', 'Should we ship on Friday?', ''].join('\n');
  const seamCandidate = [
    '# Doc',
    '',
    '- Ship date?',
    '- Owner?',
    '',
    'Should we ship on Friday?',
    '',
  ].join('\n');

  it('keeps the neighbouring paragraph a block of its own', async () => {
    const parts = await pair(seamBase, seamCandidate);
    expect(parts.hunks).toHaveLength(1);
    const merged = compose(parts, [0]);
    expect(merged).toBe(seamCandidate);
    expect((await renderDocumentBlocks(merged ?? '')).map((b) => b.raw.trim())).toEqual([
      '# Doc',
      '- Ship date?\n- Owner?',
      'Should we ship on Friday?',
    ]);
  });

  it('verifies the result re-reads as the blocks the reader picked', async () => {
    const parts = await pair(seamBase, seamCandidate);
    await expect(composeVerifiedDocument({ ...parts, accepted: new Set([0]) })).resolves.toBe(
      seamCandidate,
    );
    await expect(composeVerifiedDocument({ ...parts, accepted: new Set<number>() })).resolves.toBe(
      seamBase,
    );
  });

  it('refuses rather than writing a document it cannot verify', async () => {
    const parts = await pair(seamBase, seamCandidate);
    const drifted = parts.baseBlocks.map((b, i) =>
      i === 1 ? { ...b, endOffset: (b.endOffset ?? 0) - 2 } : b,
    );
    await expect(
      composeVerifiedDocument({ ...parts, baseBlocks: drifted, accepted: new Set([0]) }),
    ).resolves.toBeNull();
  });
});

describe('expectedBlockKeys', () => {
  it('lists base blocks for declined hunks and candidate blocks for kept ones', async () => {
    const parts = await pair(
      BASE,
      ['# Title', '', 'One!', '', 'Two.', '', 'Three!', ''].join('\n'),
    );
    expect(expectedBlockKeys({ ...parts, accepted: new Set([0]) })).toEqual([
      '# Title',
      'One!',
      'Two.',
      'Three.',
    ]);
  });
});

describe('hunkLabel', () => {
  it('names the passage a removal drops, since its toggle sits elsewhere', async () => {
    const parts = await pair(BASE, ['# Title', '', 'One.', '', 'Three.', ''].join('\n'));
    expect(hunkLabel(parts.hunks[0], parts.baseBlocks)).toBe('Include this removal: “Two.”');
    expect(hunkLabel(parts.hunks[0])).toBe('Include this removal');
  });

  it('tells rewrites and insertions apart by the base lines they land on', async () => {
    const rewrite = await pair(
      BASE,
      ['# Title', '', 'One!', '', 'Two!', '', 'Three.', ''].join('\n'),
    );
    expect(hunkLabel(rewrite.hunks[0], rewrite.baseBlocks)).toBe(
      'Include this rewrite of lines 3–5',
    );
    expect(hunkLabel(rewrite.hunks[0])).toBe('Include this rewrite');

    const inserted = await pair(
      BASE,
      ['# Title', '', 'Zero.', '', 'One.', '', 'Two.', '', 'Three.', '', 'Four.', ''].join('\n'),
    );
    expect(inserted.hunks.map((h) => hunkLabel(h, inserted.baseBlocks))).toEqual([
      'Include this new passage before line 3',
      'Include this new passage at the end',
    ]);
    expect(hunkLabel(inserted.hunks[0])).toBe('Include this new passage');
  });
});
