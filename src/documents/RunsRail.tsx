import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import {
  cancelDocumentRun,
  candidateLogKey,
  documentStore,
  openDocumentCompare,
  rejectDocumentRun,
} from './store';
import { formatRelativeAge } from '../lib/relativeAge';
import type { DocumentCandidateRecord, DocumentRunRecord } from '../ipc/types';

function scopeLabel(run: DocumentRunRecord): string {
  const s = run.scope;
  if (s.wholeDocument) return 'whole document';
  const lines = s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}–${s.endLine}`;
  return s.heading ? `${lines} · ${s.heading}` : lines;
}

function candidateState(c: DocumentCandidateRecord): string {
  if (c.status === 'running') return 'working…';
  if (c.status === 'done') return c.commitSha ? 'proposal ready' : 'no changes';
  if (c.status === 'failed') return 'failed';
  if (c.status === 'cancelled') return 'cancelled';
  return 'interrupted';
}

function CandidateRow(props: {
  runId: string;
  candidate: DocumentCandidateRecord;
  showLog: boolean;
}) {
  const lines = () => documentStore.logs[candidateLogKey(props.runId, props.candidate.id)] ?? [];
  const tail = () => lines().slice(-6);
  return (
    <div class="docws-candidate">
      <div class="docws-candidate-head">
        <span class={`docws-dot docws-dot-${props.candidate.status}`} />
        <span class="docws-candidate-label">{props.candidate.label}</span>
        <span>{props.candidate.agentName}</span>
        <Show when={props.candidate.isMain}>
          <span class="docws-badge">main</span>
        </Show>
        <span style={{ 'margin-left': 'auto', color: 'var(--fg-subtle)' }}>
          {candidateState(props.candidate)}
        </span>
      </div>
      <Show when={props.candidate.error && props.candidate.status !== 'running'}>
        <div class="docws-error">{props.candidate.error}</div>
      </Show>
      <Show when={props.showLog && tail().length > 0}>
        <div class="docws-log">{tail().join('\n')}</div>
      </Show>
    </div>
  );
}

/** Right-hand list of runs against the open document, newest first. */
export function RunsRail() {
  const runs = createMemo(() =>
    documentStore.runOrder.map((id) => documentStore.runs[id]).filter(Boolean),
  );
  const [nowMs, setNowMs] = createSignal(Date.now());
  const clock = setInterval(() => setNowMs(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));

  return (
    <aside class="docws-rail" aria-label="Runs">
      <div class="docws-rail-title">Runs</div>
      <Show when={runs().length === 0}>
        <div class="docws-empty">
          Select a passage in the document, describe what should change, and pick one or more
          agents. Proposals show up here.
        </div>
      </Show>
      <For each={runs()}>
        {(run) => {
          const proposals = () => run.candidates.filter((c) => c.commitSha).length;
          const canCompare = () =>
            (run.status === 'finished' || run.status === 'stale') && proposals() > 0;
          return (
            <div class="docws-run" data-run-id={run.id}>
              <div class="docws-run-head">
                <span class={`docws-badge docws-badge-${run.status}`}>{run.status}</span>
                <span class="docws-run-meta" title={new Date(run.createdAt).toLocaleString()}>
                  {formatRelativeAge(new Date(run.createdAt).getTime(), nowMs())}
                </span>
              </div>
              <div class="docws-run-instruction" title={run.instruction}>
                {run.instruction}
              </div>
              <div class="docws-run-meta" title={scopeLabel(run)}>
                {scopeLabel(run)} · base {run.baseSha.slice(0, 7)}
              </div>
              <For each={run.candidates}>
                {(candidate) => (
                  <CandidateRow
                    runId={run.id}
                    candidate={candidate}
                    showLog={run.status === 'running'}
                  />
                )}
              </For>
              <div class="docws-run-actions">
                <Show when={run.status === 'running'}>
                  <button
                    type="button"
                    class="docws-btn docws-btn-sm"
                    onClick={() => void cancelDocumentRun(run.id)}
                  >
                    Cancel
                  </button>
                </Show>
                <Show when={canCompare()}>
                  <button
                    type="button"
                    class="docws-btn docws-btn-sm docws-btn-primary"
                    onClick={() => openDocumentCompare(run.id)}
                  >
                    {proposals() > 1 ? `Compare ${proposals()}` : 'Review'}
                  </button>
                </Show>
                <Show when={run.status === 'finished' || run.status === 'stale'}>
                  <button
                    type="button"
                    class="docws-btn docws-btn-sm docws-btn-danger"
                    onClick={() => void rejectDocumentRun(run.id)}
                  >
                    {proposals() > 0 ? 'Reject all' : 'Dismiss'}
                  </button>
                </Show>
              </div>
            </div>
          );
        }}
      </For>
    </aside>
  );
}
