/**
 * Renders GFM tables in the live Markdown editor as real tables while the
 * caret is elsewhere, the way the editor already hides other syntax away from
 * the caret. Putting the caret in a table (a click on a cell, or the arrow
 * keys) shows its source for editing.
 *
 * The source alone cannot show a wide table well: every line is its own row
 * in CodeMirror, so the lines cannot share one sideways scrollbar. With
 * `white-space: pre` a wide row scrolled the whole document; soft-wrapped, as
 * now, a wide row loses its column alignment. A rendered table scrolls inside
 * its own box instead, like tables in the rendered document views.
 */
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { syntaxTree } from '@codemirror/language';
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view';
import { cellEnd } from './live-markdown-table-cells';
import { SANITIZE_UNTRUSTED } from './sanitize';

// The widget builds the `.md-table-scroll` box itself (see marked-table.ts),
// so the plain renderer is enough here.
const tableMarked = new Marked();

// Rough rendered height of a body row, for tables not yet drawn.
const ROW_ESTIMATE_PX = 26;

// The source each widget DOM was drawn from, so a newer widget can keep it.
const drawnFrom = new WeakMap<HTMLElement, string>();

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly generation: number,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source && other.generation === this.generation;
  }

  // A new generation keeps the DOM, but CodeMirror measures a widget it
  // updates, which nothing else makes it do for a table that grew by itself.
  override updateDOM(dom: HTMLElement): boolean {
    return drawnFrom.get(dom) === this.source;
  }

  // Unmeasured, a block widget counts as one line, so the scrollbar would jump
  // as each long table off screen is first drawn.
  override get estimatedHeight(): number {
    const rows = this.source.split('\n').length - 1; // less the delimiter row
    return Math.max(1, rows) * ROW_ESTIMATE_PX + 8;
  }

  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'cm-md-table-widget';
    const scroll = document.createElement('div');
    scroll.className = 'md-table-scroll';
    scroll.innerHTML = DOMPurify.sanitize(
      tableMarked.parse(this.source, { async: false }) as string,
      SANITIZE_UNTRUSTED,
    );
    dom.append(scroll);
    drawnFrom.set(dom, this.source);
    // An image arriving late makes the table taller than CodeMirror has on
    // record, and clicks below it would land on the wrong line. A measure
    // request is not enough: with the content stretched to a short document's
    // pane, its height does not change, so CodeMirror reads no line heights.
    const remeasure = () => {
      if (dom.isConnected) view.dispatch({ effects: remeasureTables.of(null) });
    };
    for (const img of scroll.querySelectorAll('img')) {
      img.addEventListener('load', remeasure, { once: true });
    }
    dom.addEventListener('mousedown', (event) => editCell(view, dom, event));
    // Links stay inert, as they are in the source: a click edits the cell.
    const inertLinks = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
    };
    dom.addEventListener('click', inertLinks);
    dom.addEventListener('auxclick', inertLinks);
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Puts the caret at the end of the clicked cell's text, which shows the source. */
function editCell(view: EditorView, dom: HTMLElement, event: MouseEvent): void {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  // Presses on the box's own scrollbar or around the table are left alone.
  const cell = event.target.closest('th, td');
  const row = cell?.parentElement;
  const table = row?.closest('table');
  if (!cell || !row || !table) return;
  event.preventDefault();
  const rowIndex = Array.from(table.querySelectorAll('tr')).indexOf(row as HTMLTableRowElement);
  const column = Array.from(row.children).indexOf(cell);
  const anchor = cellEnd(view.state, view.posAtDOM(dom), { rowIndex, column });
  const rowTop = cell.getBoundingClientRect().top;
  // Shift extends the selection, as a shift-click on text does.
  const selection = event.shiftKey
    ? { anchor: view.state.selection.main.anchor, head: anchor }
    : { anchor };
  view.dispatch({ selection, effects: editTables });
  view.focus();
  holdUnderPointer(view, view.state.doc.lineAt(anchor).from, rowTop);
}

/**
 * The source is taller than the rendered table, so the clicked row would drop
 * away from the pointer as it shows. Scrolls its source line back to where the
 * row was, as far as the document can scroll.
 */
function holdUnderPointer(view: EditorView, lineStart: number, top: number): void {
  view.requestMeasure({
    read: () => view.coordsAtPos(lineStart)?.top,
    write: (shown) => {
      if (shown !== undefined) scrollParent(view.scrollDOM)?.scrollBy(0, shown - top);
    },
  });
}

/** The editor scrolls itself in the canvas; inline, an ancestor scrolls it. */
function scrollParent(start: HTMLElement): HTMLElement | null {
  for (let el: HTMLElement | null = start; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
      return el;
    }
  }
  return null;
}

/**
 * Once the editor is in use, a table that a selection touches shows its
 * source; until then every table renders, wherever the caret starts.
 *
 * Leaving the editor changes nothing, so the table the caret was left in stays
 * as source. Re-rendering on blur moved the content below the table under the
 * click that caused the blur (an inline editor's Save button lost its click),
 * and putting that off until the release took more than it was worth.
 */
function buildTables(state: EditorState, inUse: boolean, generation: number): DecorationSet {
  const { doc } = state;
  const ranges = [];
  // Top-level tables only: one inside a quote or list shares its lines with
  // markers a block widget would swallow.
  const cursor = syntaxTree(state).cursor();
  if (!cursor.firstChild()) return Decoration.none;
  do {
    if (cursor.name !== 'Table') continue;
    const from = doc.lineAt(cursor.from).from;
    const to = doc.lineAt(Math.max(cursor.from, cursor.to - 1)).to;
    const touched = state.selection.ranges.some((range) => range.from <= to && range.to >= from);
    if (inUse && touched) continue;
    const widget = new TableWidget(doc.sliceString(from, to), generation);
    ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
  } while (cursor.nextSibling());
  return Decoration.set(ranges);
}

interface TableState {
  inUse: boolean;
  generation: number;
  decorations: DecorationSet;
}

const useTables = StateEffect.define<null>();
const remeasureTables = StateEffect.define<null>();

/**
 * Add to a transaction to show the source of the table under the caret from
 * that update on, before the focus arrives: for an editor opened to edit, a
 * jump to a line (scrolled against the source, not the shorter rendering), or
 * a state replaced while the editor held the focus.
 */
export const editTables: StateEffect<null> = useTables.of(null);

const affectsTables = (tr: Transaction): boolean =>
  tr.docChanged || tr.selection !== undefined || syntaxTree(tr.startState) !== syntaxTree(tr.state);

// Block widgets must come from a state field; view plugins may not replace
// line breaks.
const tableField = StateField.define<TableState>({
  create: (state) => ({ inUse: false, generation: 0, decorations: buildTables(state, false, 0) }),
  update: (value, tr) => {
    const inUse = value.inUse || tr.effects.some((effect) => effect.is(useTables));
    const remeasure = tr.effects.some((effect) => effect.is(remeasureTables));
    if (inUse === value.inUse && !remeasure && !affectsTables(tr)) return value;
    const generation = value.generation + (remeasure ? 1 : 0);
    return { inUse, generation, decorations: buildTables(tr.state, inUse, generation) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * Vertical motion steps over block widgets, so without this the arrow keys
 * could never reach a rendered table: they land on its first line going down
 * and its last line going up, which shows the source.
 */
const enterTable =
  (forward: boolean) =>
  (view: EditorView): boolean => {
    const range = view.state.selection.main;
    if (!range.empty) return false;
    const next = view.moveVertically(range, forward);
    const low = Math.min(range.head, next.head);
    const high = Math.max(range.head, next.head);
    const tables = view.state.field(tableField).decorations;
    for (const table = tables.iter(low); table.value; table.next()) {
      if (table.from >= high) break;
      if (table.from <= low || table.to >= high) continue;
      const anchor = forward ? table.from : view.state.doc.lineAt(table.to).from;
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      return true;
    }
    return false;
  };

const tableTheme = EditorView.theme({
  // Padding rather than margin: CodeMirror measures a block widget's box.
  '.cm-md-table-widget': {
    padding: '4px 0',
    // CodeMirror's content is a flex item that cannot shrink below its
    // min-content width, and a table's is the sum of its columns: without
    // this, a wide table widens the whole editor and the prose stops wrapping
    // at the pane. Containment takes the table out of that measurement, so the
    // widget fills the column and the table scrolls inside its box.
    contain: 'inline-size',
    // The editor's content wraps anywhere, which would let the table squeeze
    // every column to a letter's width instead of scrolling.
    whiteSpace: 'normal',
    overflowWrap: 'break-word',
    wordBreak: 'normal',
  },
  '.cm-md-table-widget .md-table-scroll': { maxWidth: '100%', overflowX: 'auto' },
  '.cm-md-table-widget table': { borderCollapse: 'collapse', fontSize: '0.92em', cursor: 'text' },
  '.cm-md-table-widget th, .cm-md-table-widget td': {
    border: '1px solid var(--border)',
    padding: '4px 10px',
    verticalAlign: 'top',
    // In a narrow pane a many-column table would otherwise squeeze each
    // column to its longest word before it starts to scroll.
    minWidth: '6em',
  },
  '.cm-md-table-widget th': {
    background: 'color-mix(in srgb, var(--fg) 5%, transparent)',
    fontWeight: '700',
  },
  '.cm-md-table-widget th:not([align])': { textAlign: 'left' },
  '.cm-md-table-widget code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em',
    backgroundColor: 'var(--bg-input)',
    padding: '0 3px',
    borderRadius: '3px',
  },
  '.cm-md-table-widget a': { color: 'var(--link)' },
});

/** Rendered tables for the live Markdown editor; see the module comment. */
export const liveTables: Extension = [
  tableField,
  EditorView.focusChangeEffect.of((_state, focusing) => (focusing ? editTables : null)),
  Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: enterTable(true) },
      { key: 'ArrowUp', run: enterTable(false) },
    ]),
  ),
  tableTheme,
];
