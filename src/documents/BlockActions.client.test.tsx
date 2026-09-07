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

describe('block hover actions', () => {
  it('offers every composer mode and edit on each block, and reports the block picked', () => {
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
            selectable
            onSelect={onSelect}
            onAction={onAction}
          />
        ),
        host,
      ),
    );

    const toolbars = host.querySelectorAll('[data-block-index] .docws-block-actions');
    expect(toolbars).toHaveLength(2);
    const second = host.querySelector<HTMLElement>('[data-block-index="1"]');
    const labels = Array.from(second?.querySelectorAll('button') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Task on this block',
      'Proposals for this block',
      'Note beside this block',
      'Ask an agent about this block',
      'Edit this block',
    ]);

    second?.querySelector<HTMLButtonElement>('[aria-label="Note beside this block"]')?.click();
    second?.querySelector<HTMLButtonElement>('[aria-label="Proposals for this block"]')?.click();
    second?.querySelector<HTMLButtonElement>('[aria-label="Edit this block"]')?.click();

    expect(onAction).toHaveBeenNthCalledWith(1, 'note', 1);
    expect(onAction).toHaveBeenNthCalledWith(2, 'proposals', 1);
    expect(onAction).toHaveBeenNthCalledWith(3, 'edit', 1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('gives the task and edit actions different icons', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => <DocumentViewer blocks={blocks} renderKey="t" selectable onAction={() => {}} />,
        host,
      ),
    );

    const icon = (label: string) =>
      host.querySelector(`[aria-label="${label}"] path`)?.getAttribute('d');
    expect(icon('Task on this block')).not.toEqual(icon('Edit this block'));
  });

  it('keeps the toolbars on the other blocks while a passage is picked', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <DocumentViewer
            blocks={blocks}
            renderKey="t"
            selectable
            selection={{ start: 1, end: 1 }}
            onAction={() => {}}
          />
        ),
        host,
      ),
    );

    // The picked block's toolbar is hidden by style; the rest stay in reach.
    expect(host.querySelector('[data-block-index="1"]')?.classList.contains('is-selected')).toBe(
      true,
    );
    expect(host.querySelectorAll('[data-block-index="0"] .docws-block-actions')).toHaveLength(1);
  });

  it('shows no toolbar when the viewer is not selectable', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(() => <DocumentViewer blocks={blocks} renderKey="t" onAction={() => {}} />, host),
    );

    expect(host.querySelector('.docws-block-actions')).toBeNull();
  });
});
