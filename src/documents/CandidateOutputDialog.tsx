import { Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { Dialog } from '../components/Dialog';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { getProject } from '../store/projects';
import { documentStore, modelLabel } from './store';
import { openCandidateOutput, workspaceUi } from './workspace-ui';

/** How often a running candidate's log is re-read. */
const LIVE_POLL_MS = 1_000;

/**
 * What one one-shot candidate printed: the readable log the run streamed,
 * read back from disk so it is there after the run finished or the app
 * restarted. A running candidate's log grows while the dialog is open.
 */
export function CandidateOutputDialog() {
  const [text, setText] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  let bodyRef: HTMLPreElement | undefined;
  const target = () => workspaceUi.output;
  const run = () => {
    const t = target();
    return t ? documentStore.runs[t.runId] : undefined;
  };
  const candidate = createMemo(() => run()?.candidates.find((c) => c.id === target()?.candidateId));
  const projectRoot = () =>
    documentStore.projectId ? getProject(documentStore.projectId)?.path : undefined;

  async function load() {
    const t = target();
    const root = projectRoot();
    if (!t || !root) return;
    try {
      const log = await invoke<string>(IPC.ReadDocumentCandidateLog, { projectRoot: root, ...t });
      if (workspaceUi.output !== t) return;
      const stuck =
        !!bodyRef && bodyRef.scrollTop + bodyRef.clientHeight >= bodyRef.scrollHeight - 8;
      setText(log);
      setError(null);
      if (stuck) requestAnimationFrame(() => bodyRef?.scrollTo({ top: bodyRef.scrollHeight }));
    } catch (err) {
      setError(errMessage(err));
    }
  }

  createEffect(
    on(target, (t) => {
      setText('');
      setError(null);
      if (!t) return;
      void load();
    }),
  );

  createEffect(() => {
    if (!target() || candidate()?.status !== 'running') return;
    const timer = setInterval(() => void load(), LIVE_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <Dialog open={!!target()} onClose={() => openCandidateOutput(null)} width="min(900px, 92vw)">
      <Show when={candidate()}>
        {(c) => (
          <div class="docws-output">
            <div class="docws-output-head">
              <span class="docws-candidate-label">{c().label}</span>
              <span>{c().agentName}</span>
              <Show when={c().model || c().effort}>
                <span class="docws-candidate-model">{modelLabel(c())}</span>
              </Show>
              <span class={`docws-badge docws-badge-${c().status}`}>{c().status}</span>
              <span class="docws-spacer" />
              <button
                type="button"
                class="docws-btn docws-btn-sm"
                onClick={() => openCandidateOutput(null)}
              >
                Close
              </button>
            </div>
            <div class="docws-run-instruction" title={run()?.instruction}>
              {run()?.instruction}
            </div>
            <Show when={c().error}>
              <div class="docws-error">{c().error}</div>
            </Show>
            <Show when={error()}>
              <div class="docws-error">{error()}</div>
            </Show>
            <pre class="docws-output-body" ref={bodyRef}>
              {text() || (c().status === 'running' ? 'Waiting for output…' : 'No output was kept.')}
            </pre>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
