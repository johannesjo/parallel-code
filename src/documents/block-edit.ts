import { normalizeSource, type DocumentBlock } from './markdown-blocks';

/** Map renderer offsets back to the original file without changing its line endings. */
export function blockEditRange(
  source: string,
  block: DocumentBlock,
): {
  startOffset: number;
  endOffset: number;
} {
  const { startOffset, endOffset } = block;
  if (
    startOffset === undefined ||
    endOffset === undefined ||
    normalizeSource(source).slice(startOffset, endOffset) !== block.raw.replace(/\n+$/, '')
  ) {
    throw new Error('The passage changed. Select it again to edit.');
  }
  const originalOffset = (offset: number): number => {
    let original = 0;
    for (let normalized = 0; normalized < offset; normalized++, original++) {
      if (source[original] === '\r' && source[original + 1] === '\n') original++;
    }
    return original;
  };
  return { startOffset: originalOffset(startOffset), endOffset: originalOffset(endOffset) };
}
