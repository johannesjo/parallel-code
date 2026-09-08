import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentViewer } from './DocumentViewer';
import type { DocumentBlock } from './markdown-blocks';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

const blocks: DocumentBlock[] = [
  {
    index: 0,
    type: 'paragraph',
    raw: 'Body text.\n',
    html: '<p>Body text.</p>',
    startLine: 1,
    endLine: 1,
  },
];

describe('the floating block toolbar and the viewer\u2019s hover tracking', () => {
  it('stays open while the pointer moves between its own buttons', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => <DocumentViewer blocks={blocks} renderKey="t" selectable onAction={() => {}} />,
        host,
      ),
    );
    host
      .querySelector('[data-block-index="0"] p')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const toolbar = document.querySelector<HTMLElement>('.docws-block-actions');
    expect(toolbar?.classList.contains('is-open')).toBe(true);

    // Solid routes the portalled toolbar's delegated events back through the
    // viewer; a move onto one of its buttons must not read as leaving the block.
    host.querySelector('.docws-content')?.dispatchEvent(new MouseEvent('mouseleave'));
    toolbar?.dispatchEvent(new MouseEvent('mouseenter'));
    toolbar
      ?.querySelectorAll('.docws-block-action')[1]
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(toolbar?.classList.contains('is-open')).toBe(true);
  });
});
