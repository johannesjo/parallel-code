import { For, Show, createEffect, createMemo, createUniqueId, type JSX } from 'solid-js';
import { Dialog } from '../components/Dialog';
import { isMac, windowChromeTopInset } from '../lib/platform';
import { closeDocumentCompare, documentStore, openDocumentCompare, reviewableRuns } from './store';
import { closeTopCompareForm } from './workspace-ui';
import { CompareView } from './CompareView';

const PANEL: JSX.CSSProperties = {
  padding: '0',
  gap: '0',
  overflow: 'hidden',
  height: '100%',
  'max-height': 'none',
  'border-radius': '0',
  border: 'none',
};

/**
 * The compare view fills the window: base and candidates side by side want
 * every pixel of width, and it is a decision to make and leave, not a place
 * to stay. The window chrome stays reachable: on macOS the traffic lights are
 * drawn over the head, which moves its content clear of them; elsewhere the
 * app's own title bar keeps its strip above the backdrop.
 */
export function CompareDialog() {
  const reviewable = createMemo(() => reviewableRuns());
  const runId = () => documentStore.compareRunId;
  const run = () => {
    const id = runId();
    return id ? documentStore.runs[id] : undefined;
  };
  const titleId = createUniqueId();
  let root: HTMLDivElement | undefined;

  // Focus moves into the dialog as it opens, the way the app's other dialogs
  // do, so the next Tab starts on the review and not wherever the click came from.
  createEffect(() => {
    if (!run()) return;
    requestAnimationFrame(() => root?.focus());
  });

  // Escape and a click beside the dialog close an open refine or merge form
  // first; the Close button always closes the dialog.
  function dismiss() {
    if (!closeTopCompareForm()) closeDocumentCompare();
  }

  return (
    <Dialog
      open={!!run()}
      onClose={dismiss}
      width="100%"
      panelStyle={PANEL}
      overlayStyle={isMac ? undefined : { top: `${windowChromeTopInset}px` }}
      labelledBy={titleId}
    >
      <div ref={root} class="docws-compare-dialog" classList={{ 'is-mac': isMac }} tabIndex={-1}>
        <div class="docws-compare-dialog-head" data-tauri-drag-region>
          <span class="docws-rail-title" id={titleId}>
            Compare
          </span>
          <Show when={reviewable().length > 1}>
            <select
              class="docws-select"
              aria-label="Run to compare"
              value={runId() ?? ''}
              onChange={(e) => openDocumentCompare(e.currentTarget.value)}
            >
              <For each={reviewable()}>
                {(r) => <option value={r.id}>{r.instruction.slice(0, 80)}</option>}
              </For>
            </select>
          </Show>
          <span class="docws-spacer" />
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            title="Close (Esc)"
            onClick={closeDocumentCompare}
          >
            Close
          </button>
        </div>
        <div class="docws-compare-dialog-body">
          <Show when={run() ? runId() : null} keyed>
            {(id) => (
              <CompareView
                run={documentStore.runs[id]}
                candidateId={documentStore.compareCandidateId ?? undefined}
              />
            )}
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
