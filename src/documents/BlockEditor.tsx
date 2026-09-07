import { Show, createSignal, createUniqueId, untrack } from 'solid-js';
import { Dialog } from '../components/Dialog';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { normalizeSource, type DocumentBlock } from './markdown-blocks';
import { blockEditRange } from './block-edit';

export interface BlockEditTarget {
  projectRoot: string;
  documentPath: string;
  source: string;
  block: DocumentBlock;
}

/** A small source editor; the surrounding document is preserved byte for byte. */
export function BlockEditor(props: {
  target: BlockEditTarget;
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
  const [text, setText] = createSignal(initial);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const titleId = createUniqueId();
  const close = () => {
    if (!saving()) props.onClose();
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
  }

  return (
    <Dialog open onClose={close} width="min(760px, 92vw)" labelledBy={titleId}>
      <div class="docws-block-editor">
        <h2 id={titleId}>Edit block</h2>
        <Show
          when={!stale}
          fallback={
            <p class="docws-error" role="alert">
              {stale}
            </p>
          }
        >
          <p>Edit the source for this block. Saving updates {target.documentPath} directly.</p>
          <textarea
            aria-label="Block source"
            value={text()}
            disabled={saving()}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => setText(e.currentTarget.value)}
          />
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
    </Dialog>
  );
}
