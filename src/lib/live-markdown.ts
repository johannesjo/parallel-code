/**
 * CodeMirror-backed, Obsidian-style Markdown editing, adapted from Super
 * Productivity's live Markdown editor. The source stays untouched while view
 * decorations hide syntax markers away from the caret.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { insertNewlineContinueMarkup, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, Prec, Text, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { normalizeLineEndings, preferredLineEnding } from './canvas-blocks';

export interface CanvasSelection {
  quote: string;
  startLine: number;
  endLine: number;
}

export interface CanvasEditorOptions {
  root: HTMLElement;
  defaultValue: string;
  placeholder: string;
  ariaLabel: string;
  onChange: (matchesSaved: boolean) => void;
  onSelection: (selection: CanvasSelection | null) => void;
}

export interface CanvasEditor {
  markdown(): string;
  /** Makes this source the undo-aware dirty-state baseline. */
  markSaved(markdown: string): boolean;
  load(markdown: string): void;
  /** Puts the cursor at the start of a 1-based line and scrolls it into view. */
  goToLine(line: number): void;
  /** Takes the focus with the cursor at the end, leaving the page's scroll alone. */
  focus(): void;
  destroy(): void;
}

const HIDE = Decoration.replace({});
const markCache = new Map<string, Decoration>();
const lineCache = new Map<string, Decoration>();
const checkboxClass = 'cm-md-task-checkbox';

const markFor = (cls: string): Decoration => {
  const cached = markCache.get(cls);
  if (cached) return cached;
  const decoration = Decoration.mark({ class: cls });
  markCache.set(cls, decoration);
  return decoration;
};

const lineFor = (cls: string): Decoration => {
  const cached = lineCache.get(cls);
  if (cached) return cached;
  const decoration = Decoration.line({ class: cls });
  lineCache.set(cls, decoration);
  return decoration;
};

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  override updateDOM(dom: HTMLElement): boolean {
    if (!(dom instanceof HTMLInputElement)) return false;
    dom.checked = this.checked;
    dom.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete');
    return true;
  }

  override toDOM(): HTMLElement {
    const input = document.createElement('input');
    input.className = checkboxClass;
    input.type = 'checkbox';
    input.checked = this.checked;
    input.tabIndex = 0;
    input.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete');
    return input;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const checkboxDecoration = (checked: boolean): Decoration =>
  Decoration.replace({ widget: new CheckboxWidget(checked) });

const quotePrefix = /^\s*(?:>\s*)+/;
const taskPrefix = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s?/;

const taskMatch = (line: string): { offset: number; match: RegExpExecArray } | null => {
  const offset = quotePrefix.exec(line)?.[0].length ?? 0;
  const match = taskPrefix.exec(line.slice(offset));
  return match ? { offset, match } : null;
};

const updateCheckboxAt = (view: EditorView, target: HTMLInputElement): boolean => {
  const line = view.state.doc.lineAt(view.posAtDOM(target));
  const task = taskMatch(line.text);
  if (!task) return false;
  const marker = line.from + task.offset + task.match[0].indexOf('[') + 1;
  view.dispatch({
    changes: { from: marker, to: marker + 1, insert: target.checked ? 'x' : ' ' },
  });
  return true;
};

const checkboxToggle = EditorView.domEventHandlers({
  change: (event, view) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains(checkboxClass)) {
      return false;
    }
    return updateCheckboxAt(view, target);
  },
});

const inlineClasses: Readonly<Record<string, string>> = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  Strikethrough: 'cm-md-strike',
  InlineCode: 'cm-md-code',
  Link: 'cm-md-link',
  ListMark: 'cm-md-list-mark',
};
const hiddenMarkers = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'QuoteMark',
  'LinkMark',
  'URL',
]);

const buildDecorations = (view: EditorView): DecorationSet => {
  const { doc } = view.state;
  const revealed = view.hasFocus
    ? view.state.selection.ranges.map((range) => ({
        first: doc.lineAt(range.from).number,
        last: doc.lineAt(range.to).number,
      }))
    : [];
  const isRevealed = (line: number): boolean =>
    revealed.some((range) => line >= range.first && line <= range.last);
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  const addLine = (position: number, cls: string): void => {
    const from = doc.lineAt(position).from;
    ranges.push({ from, to: from, decoration: lineFor(cls) });
  };
  const tree = syntaxTree(view.state);
  for (const visible of view.visibleRanges) {
    const region = {
      from: doc.lineAt(visible.from).from,
      to: doc.lineAt(visible.to).to,
    };
    const addBlockLines = (from: number, to: number, cls: string): void => {
      const first = Math.max(doc.lineAt(from).number, doc.lineAt(region.from).number);
      const last = Math.min(doc.lineAt(to).number, doc.lineAt(region.to).number);
      for (let n = first; n <= last; n++) addLine(doc.line(n).from, cls);
    };
    tree.iterate({
      from: region.from,
      to: region.to,
      enter: (node) => {
        const { name, from, to } = node;
        const line = doc.lineAt(from);
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
        if (heading) {
          addLine(from, `cm-md-h${heading[1]}`);
          return true;
        }
        if (name === 'Image') return false;
        if (name === 'Blockquote') {
          addBlockLines(from, to, 'cm-md-quote');
        } else if (name === 'HorizontalRule') {
          addLine(from, 'cm-md-hr');
          if (!isRevealed(line.number)) ranges.push({ from, to, decoration: HIDE });
        } else if (name === 'FencedCode' || name === 'CodeBlock') {
          addBlockLines(from, to, 'cm-md-code-block');
        } else if (name === 'Table') {
          addBlockLines(from, to, 'cm-md-table');
        } else if (name === 'TableHeader') {
          addLine(from, 'cm-md-table-header');
        } else if (name === 'TaskMarker') {
          const task = taskMatch(line.text);
          if (task) {
            const checked = task.match[3] !== ' ';
            addLine(from, checked ? 'cm-md-task cm-md-task-done' : 'cm-md-task');
            ranges.push({
              from: line.from + task.offset + task.match[1].length,
              to: line.from + task.offset + task.match[0].length,
              decoration: checkboxDecoration(checked),
            });
            return true;
          }
        } else if (name === 'URL' && node.node.parent?.name !== 'Link') {
          ranges.push({ from, to, decoration: markFor('cm-md-link') });
          return true;
        }

        const cls = inlineClasses[name];
        if (cls && to > from) ranges.push({ from, to, decoration: markFor(cls) });

        const hideCodeMark = name === 'CodeMark' && node.node.parent?.name === 'InlineCode';
        if ((hiddenMarkers.has(name) || hideCodeMark) && !isRevealed(line.number)) {
          let end = to;
          if (
            (name === 'HeaderMark' || name === 'QuoteMark') &&
            from === line.from &&
            doc.sliceString(to, to + 1) === ' '
          ) {
            end++;
          }
          if (end > from) ranges.push({ from, to: end, decoration: HIDE });
        }
        return true;
      },
    });
  }

  return Decoration.set(
    ranges.map(({ from, to, decoration }) => decoration.range(from, to)),
    true,
  );
};

const liveMarkdown = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const wrap = (left: string, right = left): Extension =>
  keymap.of([
    {
      key: `Mod-${left === '**' ? 'b' : 'i'}`,
      preventDefault: true,
      run: (view) => {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: [
            { from, insert: left },
            { from: to, insert: right },
          ],
          selection: { anchor: from + left.length, head: to + left.length },
        });
        return true;
      },
    },
  ]);

const emptyTask = /^(\s*(?:>\s*)*)(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s*$/;

/** The standard list command needs trailing content to recognize a task item. */
const exitEmptyTask = (view: EditorView): boolean => {
  const { from, to } = view.state.selection.main;
  if (from !== to) return false;
  const line = view.state.doc.lineAt(from);
  if (from !== line.to) return false;
  const match = emptyTask.exec(line.text);
  if (!match) return false;
  view.dispatch({ changes: { from: line.from + match[1].length, to: line.to } });
  return true;
};

const liveTheme = EditorView.theme({
  '&': { height: '100%', color: 'inherit', backgroundColor: 'transparent', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-ui)', lineHeight: '1.55' },
  '.cm-content': { padding: '12px 20px 48px 28px', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0' },
  '.cm-gutters': { display: 'none' },
  '.cm-md-h1': {
    fontFamily: 'var(--font-display)',
    fontSize: '22px',
    lineHeight: '28px',
    fontWeight: '700',
  },
  '.cm-md-h2': {
    fontFamily: 'var(--font-display)',
    fontSize: '18px',
    lineHeight: '24px',
    fontWeight: '700',
  },
  '.cm-md-h3': { fontSize: '16px', fontWeight: '700' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6, .cm-md-strong': { fontWeight: '700' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strike, .cm-md-task-done': { textDecoration: 'line-through' },
  '.cm-md-code, .cm-md-code-block': {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    backgroundColor: 'var(--bg-input)',
  },
  '.cm-md-code': { padding: '0 3px', borderRadius: '3px' },
  '.cm-md-link': { color: 'var(--link)', textDecoration: 'underline' },
  '.cm-md-list-mark': { color: 'var(--fg-muted)' },
  '.cm-md-task-checkbox': {
    margin: '0 6px 0 0',
    verticalAlign: '-2px',
    accentColor: 'var(--accent)',
    cursor: 'pointer',
  },
  '.cm-md-task-done': { opacity: '0.6' },
  // No `white-space: pre` here: a row wider than the pane would stretch the
  // content box and scroll the whole document sideways. The `break-spaces` that
  // `EditorView.lineWrapping` puts on the content still keeps the runs of
  // spaces inside a row, but a row that wraps loses its column alignment.
  '.cm-md-table': { fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '.cm-md-table-header': { fontWeight: '700' },
  '.cm-md-quote': {
    borderLeft: '3px solid var(--border)',
    paddingLeft: '10px',
    color: 'var(--fg-muted)',
  },
  '.cm-md-hr': { borderBottom: '1px solid var(--border)', opacity: '0.7' },
});

const describeSelection = (state: EditorState): CanvasSelection | null => {
  const { from, to } = state.selection.main;
  if (from === to) return null;
  const quote = state.sliceDoc(from, to);
  if (!quote.trim()) return null;
  return {
    quote,
    startLine: state.doc.lineAt(from).number,
    endLine: state.doc.lineAt(Math.max(from, to - 1)).number,
  };
};

export function createCanvasEditor(options: CanvasEditorOptions): CanvasEditor {
  let selectionGeneration = 0;
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let savedDocument: Text;
  const extensions: Extension[] = [
    history(),
    EditorView.lineWrapping,
    markdownLanguage,
    liveMarkdown,
    checkboxToggle,
    liveTheme,
    placeholder(options.placeholder),
    wrap('**'),
    wrap('*'),
    Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyTask }])),
    // Handles nested/ordered lists and declines fenced-code contexts.
    // Source: https://codemirror.net/docs/ref/#lang-markdown.insertNewlineContinueMarkup
    keymap.of([{ key: 'Enter', run: insertNewlineContinueMarkup }]),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({
      'aria-label': options.ariaLabel,
      spellcheck: 'true',
      autocapitalize: 'sentences',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.eq(savedDocument));
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        // Rendering the passage composer synchronously from inside a
        // CodeMirror transaction can trigger a selectionchange while its
        // DOM observer is still flushing.
        const generation = ++selectionGeneration;
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
          if (generation === selectionGeneration) {
            options.onSelection(describeSelection(update.state));
          }
        }, 0);
      }
    }),
  ];
  const stateFor = (doc: string): EditorState =>
    EditorState.create({
      doc: Text.of(normalizeLineEndings(doc).split('\n')),
      extensions: [...extensions, EditorState.lineSeparator.of(preferredLineEnding(doc))],
    });
  const view = new EditorView({
    parent: options.root,
    state: stateFor(options.defaultValue),
  });
  savedDocument = view.state.doc;

  return {
    markdown: () => view.state.doc.toString(),
    markSaved: (markdown) => {
      savedDocument = Text.of(normalizeLineEndings(markdown).split('\n'));
      return view.state.doc.eq(savedDocument);
    },
    load: (markdown) => {
      selectionGeneration++;
      clearTimeout(selectionTimer);
      const state = stateFor(markdown);
      savedDocument = state.doc;
      view.setState(state);
    },
    goToLine: (line) => {
      const doc = view.state.doc;
      const pos = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }),
      });
      view.focus();
    },
    focus: () => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.contentDOM.focus({ preventScroll: true });
    },
    destroy: () => {
      clearTimeout(selectionTimer);
      view.destroy();
    },
  };
}
