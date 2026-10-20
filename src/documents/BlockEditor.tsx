import { Show, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { Dialog } from '../components/Dialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { normalizeSource, type DocumentBlock } from './markdown-blocks';
import { blockEditRange } from './block-edit';
import { afterPress, onScrollbar } from './press';
import { createCanvasEditor } from '../lib/live-markdown';

export interface BlockEditTarget {
  projectRoot: string;
  documentPath: string;
  source: string;
  block: DocumentBlock;
}

// Edits whose editor has been shown once. A re-render rebuilds the editor; it
// takes the focus back only if it fell with the old one, not from wherever the
// user has gone on typing. Counted on the showing, not the focusing, which a
// press that became a drag never gets to.
const shownEdits = new WeakSet<BlockEditTarget>();
function focusClaim(target: BlockEditTarget): () => boolean {
  if (shownEdits.has(target))
    return () => !document.activeElement || document.activeElement === document.body;
  shownEdits.add(target);
  return () => true;
}

/** A Markdown block's source in the live editor the Markdown edit mode uses. */
function LiveSource(props: {
  initial: string;
  onInput: (text: string) => void;
  takesFocus: () => boolean;
}) {
  let root: HTMLDivElement | undefined;
  let disposed = false;
  const takesFocus = untrack(() => props.takesFocus);
  onMount(() => {
    if (!root) return;
    const editor = createCanvasEditor({
      root,
      defaultValue: untrack(() => props.initial),
      placeholder: 'Write Markdown…',
      ariaLabel: 'Block source',
      onChange: () => props.onInput(editor.markdown()),
      onSelection: () => {},
    });
    // After the double-click that opened it, so its release keeps the focus here.
    queueMicrotask(() =>
      afterPress(() => {
        if (!disposed && takesFocus()) editor.focus();
      }),
    );
    onCleanup(() => {
      disposed = true;
      editor.destroy();
    });
  });
  return <div ref={root} class="docws-block-live" />;
}

/**
 * A small source editor; the surrounding document is preserved byte for byte.
 * `inline` edits a Markdown block in place, in the live Markdown editor;
 * otherwise the source (an HTML page's markup) is edited in a dialog.
 */
export function BlockEditor(props: {
  target: BlockEditTarget;
  inline?: boolean;
  /** An edit in progress to resume; the page re-renders blocks it holds. */
  draft?: string;
  /** The edit in progress, or undefined once it matches the block again. */
  onDraft?: (text: string | undefined) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const target = untrack(() => props.target);
  // The block was rendered from an earlier read of the file. If the two have
  // parted since, the dialog says so; throwing here would escape the render
  // and take the whole window's error boundary with it.
  const prepared = ((): { range: ReturnType<typeof blockEditRange> } | { stale: string } => {
    try {
      return { range: blockEditRange(target.source, target.block) };
    } catch (err) {
      return { stale: errMessage(err) };
    }
  })();
  const stale = 'stale' in prepared ? prepared.stale : '';
  const initial =
    'stale' in prepared
      ? ''
      : normalizeSource(target.source.slice(prepared.range.startOffset, prepared.range.endOffset));
  const [text, setText] = createSignal(untrack(() => props.draft) ?? initial);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const dirty = () => text() !== initial;
  const input = (value: string) => {
    setText(value);
    props.onDraft?.(dirty() ? value : undefined);
  };
  // Cancel, Escape and a click beside the dialog all land here; an edit in
  // progress is asked about first rather than lost.
  const close = () => {
    if (saving()) return;
    if (dirty()) setConfirmDiscard(true);
    else props.onClose();
  };

  // Inline, a press elsewhere puts an untouched editor away, as it does a
  // comment; an edit in progress stays until it is saved or cancelled.
  let editorRef: HTMLDivElement | undefined;
  if (untrack(() => props.inline)) {
    const outside = (e: MouseEvent) => {
      if (editorRef?.contains(e.target as Node) || onScrollbar(e) || saving() || dirty()) return;
      props.onClose();
    };
    document.addEventListener('mousedown', outside, true);
    onCleanup(() => document.removeEventListener('mousedown', outside, true));
  }
  // The dialog handles Escape itself; inline, the editor does. Caught on the
  // way down, as the live editor would otherwise insert a line on Mod-Enter.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && props.inline) {
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      void save();
    }
  };

  async function save() {
    if (saving() || stale || text() === initial) return;
    setSaving(true);
    setError('');
    try {
      const newline = target.source.match(/\r\n|\r|\n/)?.[0] ?? '\n';
      await invoke(IPC.WriteDocumentBlock, {
        projectRoot: target.projectRoot,
        documentPath: target.documentPath,
        expectedContent: target.source,
        ...('stale' in prepared ? {} : prepared.range),
        replacement: normalizeSource(text()).replace(/\n/g, newline),
      });
      props.onSaved();
      props.onClose();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
    // The field gave up the focus while it was inert; another try starts there,
    // unless the user has since put the focus somewhere else.
    const lost = !document.activeElement || document.activeElement === document.body;
    if (error() && lost) editorRef?.querySelector<HTMLElement>('.cm-content, textarea')?.focus();
  }

  const editor = (
    <>
      <div
        ref={editorRef}
        class="docws-block-editor"
        classList={{ 'is-inline': props.inline === true }}
        // Typing on during the save would be closed away unsaved.
        inert={saving()}
        on:keydown={{ handleEvent: onKeyDown, capture: true }}
      >
        <Show
          when={!stale}
          fallback={
            <p class="docws-error" role="alert">
              {stale}
            </p>
          }
        >
          <Show
            when={!props.inline}
            fallback={
              <LiveSource initial={untrack(text)} onInput={input} takesFocus={focusClaim(target)} />
            }
          >
            <textarea
              aria-label="Block source"
              value={text()}
              disabled={saving()}
              // After the double-click that opened it, so its release keeps the focus here.
              ref={(el) =>
                queueMicrotask(() => afterPress(() => el.focus({ preventScroll: true })))
              }
              onInput={(e) => input(e.currentTarget.value)}
            />
          </Show>
        </Show>
        <Show when={error()}>
          <p class="docws-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="docws-run-actions">
          <button class="docws-btn" type="button" onClick={close} disabled={saving()}>
            {stale ? 'Close' : 'Cancel'}
          </button>
          <Show when={!stale}>
            <button
              class="docws-btn docws-btn-primary"
              type="button"
              disabled={saving() || text() === initial}
              onClick={() => void save()}
            >
              {saving() ? 'Saving…' : 'Save block'}
            </button>
          </Show>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDiscard()}
        title="Discard edits?"
        message="The changes to this block have not been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => {
          setConfirmDiscard(false);
          props.onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  );
  return (
    <Show when={!props.inline} fallback={editor}>
      <Dialog open onClose={close} width="min(640px, 92vw)" ariaLabel="Edit block">
        {editor}
      </Dialog>
    </Show>
  );
}
