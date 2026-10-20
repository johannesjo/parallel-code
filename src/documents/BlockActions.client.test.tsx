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
    type: 'heading',
    raw: '# Title\n',
    html: '<h1>Title</h1>',
    startLine: 1,
    endLine: 1,
    headingLevel: 1,
    headingText: 'Title',
  },
  {
    index: 1,
    type: 'paragraph',
    raw: 'Body text.\n',
    html: '<p>Body text.</p>',
    startLine: 3,
    endLine: 3,
  },
];

function mount(extra: { selectable?: boolean; selection?: { start: number; end: number } } = {}) {
  const onAction = vi.fn();
  const onSelect = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <DocumentViewer
          blocks={blocks}
          renderKey="t"
          selectable={extra.selectable ?? true}
          selection={extra.selection}
          onSelect={onSelect}
          onAction={onAction}
        />
      ),
      host,
    ),
  );
  return { host, onAction, onSelect };
}

/** The pointer arrives on the prose of block `index`. */
function hover(host: HTMLElement, index: number) {
  host
    .querySelector(`[data-block-index="${index}"] > div > *`)
    ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

const toolbar = () => document.querySelector<HTMLElement>('.docws-block-actions');
const isOpen = () => toolbar()?.classList.contains('is-open') === true;

describe('block hover actions', () => {
  it('floats one toolbar over the hovered block and reports the block picked', () => {
    const { host, onAction, onSelect } = mount();
    // Not in the block: a page element clipping its overflow could hide it there.
    expect(host.querySelector('.docws-block-actions')).toBeNull();
    expect(document.body.contains(toolbar())).toBe(true);
    expect(isOpen()).toBe(false);

    hover(host, 1);

    expect(isOpen()).toBe(true);
    expect(toolbar()?.style.top).toMatch(/px$/);
    const labels = Array.from(toolbar()?.querySelectorAll('button') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Rewrite with AI', 'Add comment', 'Ask about this passage']);
    expect(toolbar()?.textContent).toContain('Comment');
    toolbar()?.querySelector<HTMLButtonElement>('[aria-label="Add comment"]')?.click();
    toolbar()?.querySelector<HTMLButtonElement>('[aria-label="Rewrite with AI"]')?.click();
    expect(onAction).toHaveBeenNthCalledWith(1, 'note', 1, undefined);
    expect(onAction).toHaveBeenNthCalledWith(2, 'proposals', 1, undefined);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('stays while the pointer climbs onto it, and goes once it leaves', async () => {
    const { host } = mount();
    hover(host, 0);
    host.querySelector('.docws-content')?.dispatchEvent(new MouseEvent('mouseleave'));
    toolbar()?.dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(isOpen()).toBe(true);

    toolbar()?.dispatchEvent(new MouseEvent('mouseleave'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(isOpen()).toBe(false);
  });

  it('keeps actions scoped to the selected passage when the pointer moves elsewhere', () => {
    const { host, onAction } = mount({ selection: { start: 0, end: 1 } });
    hover(host, 1);
    expect(isOpen()).toBe(true);
    toolbar()?.querySelector<HTMLButtonElement>('[aria-label="Add comment"]')?.click();
    expect(onAction).toHaveBeenCalledWith('note', 1, { start: 0, end: 1 });
  });

  it('shows no toolbar when the viewer is not selectable', () => {
    mount({ selectable: false });
    expect(toolbar()).toBeNull();
  });
});
