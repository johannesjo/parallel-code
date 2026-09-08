import { renderHtmlBlocks } from './html-blocks';
import { isHtmlDocument } from './html-document';
import { normalizeSource, renderDocumentBlocks, type DocumentBlock } from './markdown-blocks';
import type { PageRender } from './PageBlocks';

export interface RenderedDocument {
  blocks: DocumentBlock[];
  /** Present for a whole HTML page: its marked-up body and its own stylesheet. */
  page: PageRender | null;
}

/** Markdown renders through marked; a whole HTML page becomes its element blocks. */
export async function renderDocument(source: string): Promise<RenderedDocument> {
  if (isHtmlDocument(source)) {
    const { blocks, stylesheet, html } = renderHtmlBlocks(normalizeSource(source));
    return { blocks, page: { stylesheet, html } };
  }
  return { blocks: await renderDocumentBlocks(source), page: null };
}
