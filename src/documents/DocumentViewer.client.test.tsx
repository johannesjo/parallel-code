import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('picks nothing for a plain click, so reading and copying are left alone', () => {
    const onSelect = vi.fn();
    const host = mountSelectable(onSelect);

    mouseUp(host.querySelector('[data-block-index="1"]') as HTMLElement);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps a picked passage when it is clicked again', () => {
    const onSelect = vi.fn();
    const host = mountSelectable(onSelect, { start: 1, end: 1 });

    mouseUp(host.querySelector('[data-block-index="1"]') as HTMLElement);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('scopes a selection inside one paragraph without clearing text selected for copying', () => {
    const onSelect = vi.fn();
    const host = mountSelectable(onSelect);
    const paragraph = host.querySelector('[data-block-index="0"] p');
    if (!paragraph) throw new Error('No paragraph');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    mouseUp(paragraph);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ startBlock: 0, endBlock: 0 }));
    expect(window.getSelection()?.isCollapsed).toBe(false);
    window.getSelection()?.removeAllRanges();
  });

  it('picks the passage when the selection is extended from the keyboard', () => {
    const onSelect = vi.fn();
    const host = mountSelectable(onSelect);
    const paragraph = host.querySelector('[data-block-index="0"] p');
    if (!paragraph) throw new Error('No paragraph');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    paragraph.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
    paragraph.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ startBlock: 0, endBlock: 0 }));
    window.getSelection()?.removeAllRanges();
  });

  it('still picks the section from the § handle', () => {
    const onSelect = vi.fn();
    const host = mountSelectable(onSelect);

    host.querySelector<HTMLButtonElement>('.docws-section-btn')?.click();

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ startBlock: 1 }));
  });
});

describe('DocumentViewer click to comment', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function mountWithAction(
    onAction: (kind: string, index: number, range?: unknown) => void,
    opts: { composerOpen?: () => boolean; selection?: { start: number; end: number } } = {},
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
            composerOpen={opts.composerOpen?.()}
            selection={opts.selection}
            onSelect={() => {}}
            onAction={onAction}
          />
        ),
        host,
      ),
    );
    return host;
  }

  /** A press; the comment opens once the press's other handlers have run. */
  function press(el: Element | null, detail: number) {
    el?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail, button: 0 }),
    );
  }

  function clickTimes(el: Element | null, detail: number) {
    press(el, detail);
    vi.runOnlyPendingTimers();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  it('opens a comment on the pressed block without waiting for the release', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction);

    press(host.querySelector('[data-block-index="1"] h2'), 1);
    vi.runOnlyPendingTimers();

    expect(onAction).toHaveBeenCalledWith('note', 1, undefined);
    document.dispatchEvent(new MouseEvent('mouseup'));
  });

  it('leaves a Ctrl+click to the context menu it opens on macOS', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction);

    host
      .querySelector('[data-block-index="1"] h2')
      ?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, detail: 1, button: 0, ctrlKey: true }),
      );
    vi.runOnlyPendingTimers();

    expect(onAction).not.toHaveBeenCalled();
  });

  it('does not open another comment for the second click of a double-click', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction);
    const heading = host.querySelector('[data-block-index="1"] h2');

    clickTimes(heading, 1);
    clickTimes(heading, 2);

    expect(onAction).toHaveBeenCalledOnce();
  });

  it('edits the double-clicked block in place, without selecting a word', () => {
    const onEditBlock = vi.fn();
    const onDismissComment = vi.fn();
    const [editing, setEditing] = createSignal<number | undefined>();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <DocumentViewer
            blocks={blocks}
            renderKey="t"
            selectable
            onSelect={() => {}}
            onAction={() => {}}
            onEditBlock={onEditBlock}
            onDismissComment={onDismissComment}
            editingBlock={editing()}
            blockEditor={() => <textarea aria-label="Block source" />}
          />
        ),
        host,
      ),
    );
    const heading = host.querySelector('[data-block-index="1"] h2');

    clickTimes(heading, 1);
    const second = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      detail: 2,
      button: 0,
    });
    heading?.dispatchEvent(second);

    expect(onEditBlock).toHaveBeenCalledWith(1);
    // The empty comment the first click opened makes way for the editor.
    expect(onDismissComment).toHaveBeenCalledOnce();
    expect(second.defaultPrevented).toBe(true);
    setEditing(1);
    const block = host.querySelector('[data-block-index="1"]');
    expect(block?.querySelector('textarea[aria-label="Block source"]')).not.toBeNull();
    expect(block?.querySelector('h2')).toBeNull();
    document.dispatchEvent(new MouseEvent('mouseup'));
  });

  it('leaves links and controls alone', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction);

    clickTimes(host.querySelector('a[href="#end"]'), 1);
    clickTimes(host.querySelector('.docws-section-btn'), 1);

    expect(onAction).not.toHaveBeenCalled();
  });

  it('leaves page widgets and editable regions alone', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction);
    const paragraph = host.querySelector('[data-block-index="0"] p');
    const widget = document.createElement('span');
    widget.setAttribute('role', 'button');
    const editable = document.createElement('span');
    editable.setAttribute('contenteditable', '');
    paragraph?.append(widget, editable);

    clickTimes(widget, 1);
    clickTimes(editable, 1);

    expect(onAction).not.toHaveBeenCalled();
  });

  it('does not comment when text is selected', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction);
    const paragraph = host.querySelector('[data-block-index="0"] p');
    if (!paragraph) throw new Error('No paragraph');

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.addRange(range);
    clickTimes(paragraph, 1);

    expect(onAction).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
  });

  it('comments on the whole picked passage when clicked inside it', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction, { selection: { start: 0, end: 1 } });

    clickTimes(host.querySelector('[data-block-index="0"] p'), 1);

    expect(onAction).toHaveBeenCalledWith('note', 1, { start: 0, end: 1 });
  });

  it('does not move an open composer', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction, { composerOpen: () => true });

    clickTimes(host.querySelector('[data-block-index="1"] h2'), 1);

    expect(onAction).not.toHaveBeenCalled();
  });

  it('opens the next comment with the same click that closes one', () => {
    const onAction = vi.fn();
    const [open, setOpen] = createSignal(true);
    const host = mountWithAction(onAction, { composerOpen: open });
    const heading = host.querySelector('[data-block-index="1"] h2');

    // The open comment shuts on the same press, in a handler of its own.
    press(heading, 1);
    setOpen(false);
    vi.runOnlyPendingTimers();

    expect(onAction).toHaveBeenCalledWith('note', 1, undefined);
  });

  it('puts the comment away when the press turns into a drag', () => {
    const onAction = vi.fn();
    const onDismissComment = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <DocumentViewer
            blocks={blocks}
            renderKey="t"
            selectable
            onAction={onAction}
            onDismissComment={onDismissComment}
          />
        ),
        host,
      ),
    );
    const heading = host.querySelector('[data-block-index="1"] h2');

    press(heading, 1);
    vi.runOnlyPendingTimers();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 0 }));
    expect(onDismissComment).not.toHaveBeenCalled();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 0 }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismissComment).toHaveBeenCalledOnce();
  });

  it('forgets a press whose release the window never saw', () => {
    const onDismissComment = vi.fn();
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
            onDismissComment={onDismissComment}
          />
        ),
        host,
      ),
    );
    for (const end of [
      () => window.dispatchEvent(new Event('blur')),
      () => document.dispatchEvent(new Event('dragend', { bubbles: true })),
    ]) {
      press(host.querySelector('[data-block-index="1"] h2'), 1);
      vi.runOnlyPendingTimers();
      end();
      // Later moves belong to whatever comes next, not to that press.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 0 }));
    }
    expect(onDismissComment).not.toHaveBeenCalled();
  });

  it('does not open a comment for a drag that starts before it would', () => {
    const onAction = vi.fn();
    const host = mountWithAction(onAction);

    press(host.querySelector('[data-block-index="1"] h2'), 1);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 0 }));
    vi.runOnlyPendingTimers();

    expect(onAction).not.toHaveBeenCalled();
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
