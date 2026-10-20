import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('hides its floating toolbar when the panel becomes invisible', () => {
    const [visible, setVisible] = createSignal(true);
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <DocumentViewer
            blocks={blocks}
            renderKey="visibility"
            selectable
            onAction={() => {}}
            floatingUiVisible={visible()}
          />
        ),
        host,
      ),
    );
    host
      .querySelector('[data-block-index="0"] p')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const toolbar = document.querySelector<HTMLElement>('.docws-block-actions');
    expect(toolbar?.classList.contains('is-open')).toBe(true);
    setVisible(false);
    expect(toolbar?.classList.contains('is-open')).toBe(false);
    expect(toolbar?.inert).toBe(true);
  });
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

  it('keeps offering actions on a hovered block while a comment is open', () => {
    const two: DocumentBlock[] = [
      ...blocks,
      { ...blocks[0], index: 1, raw: 'More.\n', html: '<p>More.</p>', startLine: 3, endLine: 3 },
    ];
    const onAction = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <DocumentViewer
            blocks={two}
            renderKey="t"
            selectable
            composerOpen
            selection={{ start: 0, end: 0 }}
            onAction={onAction}
          />
        ),
        host,
      ),
    );
    const toolbar = document.querySelector<HTMLElement>('.docws-block-actions');
    expect(toolbar?.classList.contains('is-open')).toBe(false);

    host
      .querySelector('[data-block-index="1"] p')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(toolbar?.classList.contains('is-open')).toBe(true);
    toolbar?.querySelector<HTMLElement>('[data-kind="question"]')?.click();

    // The open comment's passage is block 0; the action is for the hovered block alone.
    expect(onAction).toHaveBeenCalledWith('question', 1, undefined);
  });

  it('offers no actions over a block being edited in place', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <DocumentViewer
            blocks={blocks}
            renderKey="t"
            selectable
            onAction={() => {}}
            editingBlock={0}
            blockEditor={() => <p class="editor">Editing</p>}
          />
        ),
        host,
      ),
    );
    host
      .querySelector('[data-block-index="0"] .editor')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const toolbar = document.querySelector<HTMLElement>('.docws-block-actions');
    expect(toolbar?.classList.contains('is-open')).toBe(false);
  });
});
