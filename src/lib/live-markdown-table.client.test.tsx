import { EditorView } from '@codemirror/view';
import DOMPurify from 'dompurify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasEditor, type CanvasEditor } from './live-markdown';
import { SANITIZE_UNTRUSTED } from './sanitize';

// Under happy-dom, DOMPurify's output loses its first element's tags (the
// table itself here); Chromium has no such quirk. A pass-through still shows
// which policy the table is sanitized with.
vi.mock('dompurify', () => ({ default: { sanitize: vi.fn((html: string) => html) } }));

const SOURCE =
  'Intro\n\n| Name | Note |\n|---|---|\n| a |  |\n| b | **bold** [x](https://e.x) |\n\nOutro';

let editor: CanvasEditor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.replaceChildren();
});

const LEADING = '| A | B |\n|---|---|\n| 1 | 2 |\n\nafter';

function mount(
  source = SOURCE,
  extra: { editing?: boolean } = {},
): { root: HTMLElement; view: EditorView } {
  const root = document.createElement('div');
  document.body.append(root);
  editor = createCanvasEditor({
    root,
    defaultValue: source,
    placeholder: '',
    ariaLabel: 'Doc',
    onChange: () => {},
    onSelection: () => {},
    ...extra,
  });
  const dom = root.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('no editor view');
  return { root, view };
}

// CodeMirror reports a focus change after a short delay.
const focus = async (view: EditorView) => {
  view.contentDOM.focus();
  await new Promise((resolve) => setTimeout(resolve, 20));
};

const press = (target: Element) =>
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));

describe('live markdown tables', () => {
  it('renders a table in its own scroll box while the caret is elsewhere', () => {
    const { root } = mount();
    const widget = root.querySelector('.cm-md-table-widget');
    expect(widget?.querySelector('.md-table-scroll > table')).not.toBeNull();
    expect(Array.from(widget?.querySelectorAll('th') ?? [], (th) => th.textContent)).toEqual([
      'Name',
      'Note',
    ]);
    expect(widget?.querySelector('td strong')?.textContent).toBe('bold');
    expect(root.querySelector('.cm-content')?.textContent).not.toContain('|---|');
    expect(DOMPurify.sanitize).toHaveBeenCalledWith(expect.any(String), SANITIZE_UNTRUSTED);
  });

  it('renders a table that holds the caret until the editor is in use', async () => {
    const { root, view } = mount(LEADING);
    expect(view.state.selection.main.head).toBe(0);
    expect(root.querySelector('.cm-md-table-widget')).not.toBeNull();
    await focus(view);
    expect(view.hasFocus).toBe(true);
    expect(root.querySelector('.cm-md-table-widget')).toBeNull();
  });

  it('opens an editor meant for editing with the source showing', () => {
    const { root } = mount(LEADING, { editing: true });
    expect(root.querySelector('.cm-md-table-widget')).toBeNull();
  });

  it('keeps the source showing when the text is reloaded under the focus', async () => {
    const { root, view } = mount();
    await focus(view);
    expect(view.hasFocus).toBe(true);
    editor?.load(LEADING);
    // happy-dom's selection sync moves the caret after a reload; Chromium
    // leaves it at the start. What matters is that the editor is still in use.
    view.dispatch({ selection: { anchor: 0 } });
    expect(root.querySelector('.cm-md-table-widget')).toBeNull();
    expect(root.querySelector('.cm-content')?.textContent).toContain('| 1 | 2 |');
  });

  // Re-rendering on blur moved the content below the table (an inline
  // editor's Save button) out from under the click that caused the blur.
  it('leaves the layout alone when the focus moves on', async () => {
    const { root, view } = mount(LEADING);
    await focus(view);
    view.contentDOM.blur();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.hasFocus).toBe(false);
    expect(root.querySelector('.cm-md-table-widget')).toBeNull();
  });

  // Scrolled against the shorter rendering, a line deep in a long table
  // would land off screen once the source showed.
  it('shows the source of a table in the same update that jumps into it', () => {
    const { root, view } = mount();
    editor?.goToLine(5);
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('| a |  |');
    expect(root.querySelector('.cm-md-table-widget')).toBeNull();
  });

  it('extends the selection on a shift-press', async () => {
    const { root, view } = mount();
    // Focused first: happy-dom collapses the selection CodeMirror reads back
    // when it takes the focus; Chromium does not.
    await focus(view);
    view.dispatch({ selection: { anchor: 2 } });
    const cell = root.querySelectorAll('.cm-md-table-widget td')[0];
    cell.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
    );
    const { anchor, head } = view.state.selection.main;
    expect(anchor).toBe(2);
    expect(view.state.sliceDoc(head - 1, head)).toBe('a');
  });

  it('shows the source with the caret at the end of the pressed cell', () => {
    const { root, view } = mount();
    const cells = root.querySelectorAll('.cm-md-table-widget td');
    press(cells[3]); // row "b", column "Note"
    const head = view.state.selection.main.head;
    expect(view.state.sliceDoc(head - 3, head + 2)).toBe('.x) |');
    expect(root.querySelector('.cm-md-table-widget')).toBeNull();
    expect(root.querySelector('.cm-content')?.textContent).toContain('|---|');
  });

  it('finds an empty cell by its pipes', () => {
    const { root, view } = mount();
    press(root.querySelectorAll('.cm-md-table-widget td')[1]); // row "a", empty "Note"
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    expect(line.text).toBe('| a |  |');
    expect(head - line.from).toBe(line.text.length - 1);
  });

  it('renders the table again once the caret leaves it', () => {
    const { root, view } = mount();
    press(root.querySelectorAll('.cm-md-table-widget td')[0]);
    expect(root.querySelector('.cm-md-table-widget')).toBeNull();
    view.dispatch({ selection: { anchor: 0 } });
    expect(root.querySelector('.cm-md-table-widget')).not.toBeNull();
  });

  it('leaves the markdown untouched', () => {
    mount();
    expect(editor?.markdown()).toBe(SOURCE);
  });
});
