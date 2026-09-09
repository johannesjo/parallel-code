import { describe, expect, it } from 'vitest';
import { blockLineRange, planBlockWrite } from './canvas-blocks';
import type { BlockWrite, EditorBlock, SourceBlock } from './canvas-blocks';

// Three blocks; the source keeps its own bullet style while the editor
// serialises with the normalised one, as the real serialiser does.
const source = '# Title\n\n* one\n* two\n\nClosing.\n';
const sourceBlocks: SourceBlock[] = [
  { start: 0, end: 7, kind: 'heading' },
  { start: 9, end: 20, kind: 'list' },
  { start: 22, end: 30, kind: 'paragraph' },
];
const base: EditorBlock[] = [
  { text: '# Title', kind: 'heading' },
  { text: '- one\n- two', kind: 'list' },
  { text: 'Closing.', kind: 'paragraph' },
];
const whole = '# Title\n\n- one\n- two\n\nClosing.\n';

const apply = (write: BlockWrite | null): string | null =>
  write
    ? source.slice(0, write.startOffset) + write.replacement + source.slice(write.endOffset)
    : null;

describe('planBlockWrite', () => {
  it('returns null when nothing changed', () => {
    expect(
      planBlockWrite({ source, sourceBlocks, baseBlocks: base, editedBlocks: base, whole }),
    ).toBe(null);
  });

  it('writes only the edited block, leaving the others in their original form', () => {
    const edited = [base[0], base[1], { text: 'Closing words.', kind: 'paragraph' }];
    const write = planBlockWrite({
      source,
      sourceBlocks,
      baseBlocks: base,
      editedBlocks: edited,
      whole,
    });
    expect(write).toEqual({ startOffset: 22, endOffset: 30, replacement: 'Closing words.' });
    expect(apply(write)).toBe('# Title\n\n* one\n* two\n\nClosing words.\n');
  });

  it('inserts new blocks after the block they follow, and before the first one', () => {
    const after = [base[0], { text: 'Intro.', kind: 'paragraph' }, base[1], base[2]];
    expect(
      apply(planBlockWrite({ source, sourceBlocks, baseBlocks: base, editedBlocks: after, whole })),
    ).toBe('# Title\n\nIntro.\n\n* one\n* two\n\nClosing.\n');
    const before = [{ text: 'Lead.', kind: 'paragraph' }, ...base];
    expect(
      apply(
        planBlockWrite({ source, sourceBlocks, baseBlocks: base, editedBlocks: before, whole }),
      ),
    ).toBe('Lead.\n\n# Title\n\n* one\n* two\n\nClosing.\n');
  });

  it('appends at the end without touching the trailing newline', () => {
    const edited = [...base, { text: 'More.', kind: 'paragraph' }];
    expect(
      apply(
        planBlockWrite({ source, sourceBlocks, baseBlocks: base, editedBlocks: edited, whole }),
      ),
    ).toBe('# Title\n\n* one\n* two\n\nClosing.\n\nMore.\n');
  });

  it('deletes a block together with the gap before it', () => {
    const edited = [base[0], base[2]];
    expect(
      apply(
        planBlockWrite({ source, sourceBlocks, baseBlocks: base, editedBlocks: edited, whole }),
      ),
    ).toBe('# Title\n\nClosing.\n');
  });

  it('replaces a changed run of blocks in one write', () => {
    const edited = [
      { text: '# New title', kind: 'heading' },
      { text: '- one\n- two\n- three', kind: 'list' },
      base[2],
    ];
    expect(
      apply(
        planBlockWrite({ source, sourceBlocks, baseBlocks: base, editedBlocks: edited, whole }),
      ),
    ).toBe('# New title\n\n- one\n- two\n- three\n\nClosing.\n');
  });

  it('rewrites the whole file when the source blocks do not line up with the editor', () => {
    const shifted = [sourceBlocks[0], { start: 9, end: 20, kind: 'html' }, sourceBlocks[2]];
    const edited = [base[0], base[1], { text: 'Changed.', kind: 'paragraph' }];
    expect(
      planBlockWrite({
        source,
        sourceBlocks: shifted,
        baseBlocks: base,
        editedBlocks: edited,
        whole,
      }),
    ).toEqual({ startOffset: 0, endOffset: source.length, replacement: whole });
    expect(
      planBlockWrite({
        source,
        sourceBlocks: sourceBlocks.slice(1),
        baseBlocks: base,
        editedBlocks: edited,
        whole,
      }),
    ).toEqual({ startOffset: 0, endOffset: source.length, replacement: whole });
  });

  it('fills an empty file', () => {
    const edited = [{ text: 'Hello.', kind: 'paragraph' }];
    expect(
      planBlockWrite({
        source: '',
        sourceBlocks: [],
        baseBlocks: [],
        editedBlocks: edited,
        whole: 'Hello.\n',
      }),
    ).toEqual({ startOffset: 0, endOffset: 0, replacement: 'Hello.\n' });
  });
});

describe('blockLineRange', () => {
  it('maps block indexes to 1-based source lines', () => {
    expect(blockLineRange(source, sourceBlocks, 1, 1)).toEqual({ startLine: 3, endLine: 4 });
    expect(blockLineRange(source, sourceBlocks, 0, 2)).toEqual({ startLine: 1, endLine: 6 });
  });

  it('returns null for blocks the source does not have', () => {
    expect(blockLineRange(source, sourceBlocks, 2, 3)).toBeNull();
    expect(blockLineRange(source, sourceBlocks, 2, 1)).toBeNull();
  });
});
