import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { Dialog } from '../components/Dialog';
import { closeDocumentCompare, documentStore, openDocumentCompare, reviewableRuns } from './store';
import { CompareView } from './CompareView';

const WINDOWED: JSX.CSSProperties = {
  padding: '0',
  gap: '0',
  overflow: 'hidden',
  height: 'min(920px, 88vh)',
  'max-height': '88vh',
};

const FULLSCREEN: JSX.CSSProperties = {
  padding: '0',
  gap: '0',
  overflow: 'hidden',
  height: '100vh',
  'max-height': '100vh',
  'border-radius': '0',
  border: 'none',
};

/**
 * The compare view as a modal over the workspace: it wants the whole width
 * for base and candidates side by side, and it is a decision to make and
 * leave, not a place to stay. Grows to the full window on request.
 */
export function CompareDialog() {
  const [fullscreen, setFullscreen] = createSignal(false);
  const reviewable = createMemo(() => reviewableRuns());
  const runId = () => documentStore.compareRunId;
  const run = () => {
    const id = runId();
    return id ? documentStore.runs[id] : undefined;
  };

  return (
    <Dialog
      open={!!run()}
      onClose={closeDocumentCompare}
      width={fullscreen() ? '100vw' : 'min(1500px, 94vw)'}
      panelStyle={fullscreen() ? FULLSCREEN : WINDOWED}
    >
      <div class="docws-compare-dialog">
        <div class="docws-compare-dialog-head">
          <span class="docws-rail-title">Compare</span>
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
            aria-pressed={fullscreen()}
            title={fullscreen() ? 'Back to a window' : 'Fill the window'}
            onClick={() => setFullscreen((f) => !f)}
          >
            {fullscreen() ? 'Shrink' : 'Fullscreen'}
          </button>
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
            {(id) => <CompareView run={documentStore.runs[id]} />}
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
