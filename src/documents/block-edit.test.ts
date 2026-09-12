import { describe, expect, it, vi } from 'vitest';
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));
import { renderDocument } from './render-document';
import { blockEditRange } from './block-edit';

describe('blockEditRange', () => {
  it('preserves CRLF separators and selects the correct repeated paragraph', async () => {
    const source = '# Plan\r\n\r\nSame.\r\n\r\nSame.\r\n';
    const { blocks } = await renderDocument(source);
    const range = blockEditRange(source, blocks[2]);
    expect(source.slice(range.startOffset, range.endOffset)).toBe('Same.');
    expect(source.slice(0, range.startOffset) + 'Changed.' + source.slice(range.endOffset)).toBe(
      '# Plan\r\n\r\nSame.\r\n\r\nChanged.\r\n',
    );
  });

  it('selects one HTML block without touching siblings on the same line', async () => {
    const source = '<!doctype html><html><body><p>Same.</p><p>Same.</p></body></html>';
    const { blocks } = await renderDocument(source);
    const range = blockEditRange(source, blocks[1]);
    expect(
      source.slice(0, range.startOffset) + '<p>Changed.</p>' + source.slice(range.endOffset),
    ).toBe('<!doctype html><html><body><p>Same.</p><p>Changed.</p></body></html>');
  });

  it('refuses blocks from a different render', async () => {
    const { blocks } = await renderDocument('# Before');
    expect(() => blockEditRange('# After', blocks[0])).toThrow(/changed/);
  });
});
