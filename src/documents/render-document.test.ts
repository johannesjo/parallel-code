import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/shiki-highlighter', () => ({
  highlightLines: async (code: string) => code.split('\n').map((l) => `<span>${l}</span>`),
}));
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

import { renderDocument } from './render-document';

describe('renderDocument', () => {
  it('renders markdown with no stylesheet', async () => {
    const result = await renderDocument('# Title\n\nText <b>with</b> html.\n');
    expect(result.page).toBeNull();
    expect(result.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
  });

  it('renders a whole page as element blocks with its stylesheet', async () => {
    const result = await renderDocument(
      '<!doctype html>\r\n<html><head><style>p { x: y }</style></head>\r\n<body>\r\n<p>Hi</p>\r\n</body></html>',
    );
    expect(result.page?.stylesheet).toBe('p { x: y }');
    expect(result.blocks.map((b) => [b.type, b.startLine])).toEqual([['p', 4]]);
  });
});
