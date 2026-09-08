import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentViewer, releasesSelection } from './DocumentViewer';
import type { DocumentBlock } from './markdown-blocks';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/ipc', () => ({ invoke }));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const blocks: DocumentBlock[] = [
  {
    index: 0,
    type: 'paragraph',
    raw: 'See [the guide](../guide/setup.md#install), [web](https://example.com) and [below](#end).\n',
    html: '<p>See <a href="../guide/setup.md#install">the guide</a>, <a href="https://example.com">web</a> and <a href="#end">below</a>.</p>',
    startLine: 1,
    endLine: 1,
  },
  {
    index: 1,
    type: 'heading',
    raw: '## End\n',
    html: '<h2>End</h2>',
    startLine: 3,
    endLine: 3,
    headingLevel: 2,
    headingText: 'End',
  },
];

function mount(onNavigate: (path: string, anchor?: string) => void) {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <DocumentViewer
          blocks={blocks}
          renderKey="t"
          documentPath="docs/notes/readme.md"
          onNavigate={onNavigate}
        />
      ),
      host,
    ),
  );
  return host;
}

function click(link: Element | null): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link?.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('DocumentViewer links', () => {
  it('opens another file of the project inside the workspace', () => {
    const onNavigate = vi.fn();
    const host = mount(onNavigate);

    const prevented = click(host.querySelector('a[href="../guide/setup.md#install"]'));

    expect(prevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith('docs/guide/setup.md', 'install');
  });

  it('hands web links to the browser instead of the app window', () => {
    const host = mount(vi.fn());

    const prevented = click(host.querySelector('a[href="https://example.com"]'));

    expect(prevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('__shell_open_external', { url: 'https://example.com' });
  });

  it('scrolls to a heading for an in-page anchor', () => {
    const onNavigate = vi.fn();
    const host = mount(onNavigate);
    const heading = host.querySelector<HTMLElement>('h2');
    if (heading) heading.scrollIntoView = vi.fn();

    click(host.querySelector('a[href="#end"]'));

    expect(heading?.scrollIntoView).toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('picking a passage', () => {
  function mountSelectable(
    onSelect: (s: unknown) => void,
    selection?: { start: number; end: number },
  ) {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <DocumentViewer
            blocks={blocks}
            renderKey="t"
            selectable
            selection={selection}
            onSelect={onSelect}
          />
        ),
        host,
      ),
    );
    return host;
  }

  function mouseUp(el: Element) {
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  it('keeps the passage picked when the block already picked is clicked again', () => {
    const onSelect = vi.fn();
    // The pane owns the selection, so a block already picked comes in as a prop.
    const host = mountSelectable(onSelect, { start: 1, end: 1 });

    mouseUp(host.querySelector('[data-block-index="1"]') as HTMLElement);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ startBlock: 1, endBlock: 1 }));
  });

  it('moves the passage to another block', () => {
    const onSelect = vi.fn();
    const host = mountSelectable(onSelect);

    mouseUp(host.querySelector('[data-block-index="1"]') as HTMLElement);
    mouseUp(host.querySelector('[data-block-index="0"]') as HTMLElement);

    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ startBlock: 0 }));
  });
});

describe('releasesSelection', () => {
  it('lets the passage go for a click on the backdrop', () => {
    const backdrop = document.createElement('div');
    document.body.append(backdrop);

    expect(releasesSelection(backdrop)).toBe(true);
  });

  it('holds on for a click on a block or on one of its controls', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div data-block-index="0"><p>Prose</p><button type="button">Task</button></div>';
    document.body.append(host);

    expect(releasesSelection(host.querySelector('p'))).toBe(false);
    expect(releasesSelection(host.querySelector('button'))).toBe(false);
    expect(releasesSelection(host.querySelector('[data-block-index]'))).toBe(false);
  });

  it('holds on when a drag merely ended out in the margin', () => {
    const backdrop = document.createElement('div');
    backdrop.textContent = 'margin';
    document.body.append(backdrop);
    const range = document.createRange();
    range.selectNodeContents(backdrop);
    const native = window.getSelection();
    native?.removeAllRanges();
    native?.addRange(range);

    expect(releasesSelection(backdrop)).toBe(false);

    native?.removeAllRanges();
  });

  it('holds on when there is no element under the pointer', () => {
    expect(releasesSelection(null)).toBe(false);
  });
});

describe('choosing which changes land', () => {
  function mountWithHunks(args: {
    onToggleHunk?: (id: number) => void;
    declined?: (index: number) => boolean;
    accepted?: () => boolean;
    stacked?: boolean;
    onSelect?: (s: unknown) => void;
  }) {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <DocumentViewer
            blocks={blocks}
            renderKey="t"
            selectable
            onSelect={args.onSelect}
            changes={['changed', 'same']}
            hunkLeads={(i) =>
              i === 0
                ? [
                    {
                      id: 7,
                      accepted: args.accepted ? args.accepted() : true,
                      label: 'Include this rewrite',
                    },
                    ...(args.stacked
                      ? [{ id: 8, accepted: true, label: 'Include this removal: “Gone.”' }]
                      : []),
                  ]
                : []
            }
            onToggleHunk={args.onToggleHunk}
            declined={args.declined}
          />
        ),
        host,
      ),
    );
    return host;
  }

  it('offers one toggle on the block that leads the change', () => {
    const host = mountWithHunks({});

    const toggles = host.querySelectorAll<HTMLInputElement>('.docws-hunk-toggle input');
    expect(toggles).toHaveLength(1);
    expect(toggles[0].checked).toBe(true);
    expect(toggles[0].getAttribute('aria-label')).toBe('Include this rewrite');
    expect(toggles[0].closest('[data-block-index]')?.getAttribute('data-block-index')).toBe('0');
  });

  // The gutter costs the prose 28px; a column showing no toggles keeps it.
  it('opens the toggle gutter only for a column that has toggles', () => {
    expect(mountWithHunks({}).querySelector('.docws-hunk-gutter')).not.toBeNull();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(render(() => <DocumentViewer blocks={blocks} renderKey="t" />, host));
    expect(host.querySelector('.docws-hunk-gutter')).toBeNull();
  });

  // Two removals can meet on one block; each still needs its own toggle.
  it('stacks every change that lands on the same block', () => {
    const host = mountWithHunks({ stacked: true });

    const labels = [...host.querySelectorAll('.docws-hunk-toggle input')].map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Include this rewrite', 'Include this removal: “Gone.”']);
  });

  it('reports the change the reader declined', () => {
    const onToggleHunk = vi.fn();
    const host = mountWithHunks({ onToggleHunk });

    const toggle = host.querySelector<HTMLInputElement>('.docws-hunk-toggle input');
    if (!toggle) throw new Error('no toggle rendered');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onToggleHunk).toHaveBeenCalledWith(7);
  });

  it('marks a declined block as not landing, and leaves the others alone', () => {
    const host = mountWithHunks({ accepted: () => false, declined: (i) => i === 0 });

    expect(host.querySelector<HTMLInputElement>('.docws-hunk-toggle input')?.checked).toBe(false);
    expect(host.querySelector('[data-block-index="0"]')?.classList.contains('is-declined')).toBe(
      true,
    );
    expect(host.querySelector('[data-block-index="1"]')?.classList.contains('is-declined')).toBe(
      false,
    );
  });

  // The compare view drives these from a signal; nothing else pins that the
  // checkbox and the dimming follow it rather than freezing at first render.
  it("follows the reader's choice without re-creating the checkbox", () => {
    const [kept, setKept] = createSignal(true);
    const host = mountWithHunks({ accepted: kept, declined: () => !kept() });
    const before = host.querySelector('.docws-hunk-toggle input');

    setKept(false);

    expect(host.querySelector<HTMLInputElement>('.docws-hunk-toggle input')?.checked).toBe(false);
    expect(host.querySelector('[data-block-index="0"]')?.classList.contains('is-declined')).toBe(
      true,
    );
    // Same element: a recreated checkbox would drop keyboard focus on toggle.
    expect(host.querySelector('.docws-hunk-toggle input')).toBe(before);

    setKept(true);
    expect(host.querySelector<HTMLInputElement>('.docws-hunk-toggle input')?.checked).toBe(true);
  });

  it('does not pick the passage when the toggle is clicked', () => {
    const onSelect = vi.fn();
    const host = mountWithHunks({ onSelect });

    host
      .querySelector('.docws-hunk-toggle input')
      ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(onSelect).not.toHaveBeenCalled();
  });
});
