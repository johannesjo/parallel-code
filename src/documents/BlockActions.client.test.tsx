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
    expect(labels).toEqual([
      'Edit this block with agent',
      'Proposals for this block',
      'Note beside this block',
      'Ask an agent about this block',
      'Edit this block',
    ]);

    toolbar()?.querySelector<HTMLButtonElement>('[aria-label="Note beside this block"]')?.click();
    toolbar()?.querySelector<HTMLButtonElement>('[aria-label="Proposals for this block"]')?.click();
    toolbar()?.querySelector<HTMLButtonElement>('[aria-label="Edit this block"]')?.click();

    expect(onAction).toHaveBeenNthCalledWith(1, 'note', 1);
    expect(onAction).toHaveBeenNthCalledWith(2, 'proposals', 1);
    expect(onAction).toHaveBeenNthCalledWith(3, 'edit', 1);
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

  it('gives the task and edit actions different icons', () => {
    mount();
    const icon = (label: string) =>
      toolbar()?.querySelector(`[aria-label="${label}"] path`)?.getAttribute('d');
    expect(icon('Edit this block with agent')).not.toEqual(icon('Edit this block'));
  });

  it('keeps the toolbar for the other blocks while a passage is picked', () => {
    const { host } = mount({ selection: { start: 1, end: 1 } });
    expect(host.querySelector('[data-block-index="1"]')?.classList.contains('is-selected')).toBe(
      true,
    );

    // The picked block has the composer up on it; the bar would only repeat it.
    hover(host, 1);
    expect(isOpen()).toBe(false);

    hover(host, 0);
    expect(isOpen()).toBe(true);
  });

  it('shows no toolbar when the viewer is not selectable', () => {
    mount({ selectable: false });
    expect(toolbar()).toBeNull();
  });
});
