import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import {
  activeDocumentPath,
  cancelDocumentRun,
  candidateLogKey,
  documentStore,
  modelLabel,
  openDocumentCompare,
} from './store';
import { openCandidateOutput } from './workspace-ui';
import { RejectRunButton } from './RejectRunConfirm';
import { formatRelativeAge } from '../lib/relativeAge';
import type { DocumentCandidateRecord, DocumentRunRecord } from './types';

/** Where a run's starting content came from, when not the canonical document. */
function lineageLabel(run: DocumentRunRecord): string | null {
  const source = run.refinement ?? run.merge;
  if (!source) return null;
  const labels = documentStore.runs[source.runId]?.candidates ?? [];
  const label = (id: string) => labels.find((c) => c.id === id)?.label ?? id;
  if (run.merge) return `merges ${run.merge.candidateIds.map(label).join(' + ')}`;
  return run.refinement ? `refines candidate ${label(run.refinement.candidateId)}` : null;
}

function scopeLabel(run: DocumentRunRecord): string {
  const s = run.scope;
  if (s.wholeDocument) return 'whole document';
  const lines = s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}–${s.endLine}`;
  return s.heading ? `${lines} · ${s.heading}` : lines;
}

/** What the run's outcome means for one candidate. */
type CandidateVerdict = 'accepted' | 'passed-over' | 'rejected' | null;

function candidateVerdict(run: DocumentRunRecord, c: DocumentCandidateRecord): CandidateVerdict {
  if (run.acceptedCandidateId === c.id) return 'accepted';
  if (!c.commitSha) return null;
  if (run.status === 'accepted') return 'passed-over';
  if (run.status === 'rejected') return 'rejected';
  return null;
}

function candidateState(c: DocumentCandidateRecord, verdict: CandidateVerdict): string {
  if (verdict === 'accepted') return 'accepted';
  if (verdict === 'passed-over') return 'not chosen';
  if (verdict === 'rejected') return 'rejected';
  if (c.status === 'running') return 'working…';
  if (c.status === 'done') return c.commitSha ? 'proposal ready' : 'no changes';
  if (c.status === 'failed') return 'failed';
  if (c.status === 'cancelled') return 'cancelled';
  return 'interrupted';
}

function CandidateRow(props: {
  run: DocumentRunRecord;
  candidate: DocumentCandidateRecord;
  showLog: boolean;
}) {
  const lines = () => documentStore.logs[candidateLogKey(props.run.id, props.candidate.id)] ?? [];
  const tail = () => lines().slice(-6);
  const verdict = () => candidateVerdict(props.run, props.candidate);
  const canReview = () =>
    (props.run.status === 'finished' || props.run.status === 'stale') &&
    props.candidate.status === 'done' &&
    !!props.candidate.commitSha;
  const output = () =>
    openCandidateOutput({ runId: props.run.id, candidateId: props.candidate.id });

  return (
    <div
      class="docws-candidate"
      classList={{ 'is-passed-over': verdict() === 'passed-over' || verdict() === 'rejected' }}
    >
      <button
        type="button"
        class="docws-candidate-main"
        aria-label={`${canReview() ? 'Review' : 'View output for'} proposal ${props.candidate.label}`}
        onClick={() =>
          canReview() ? openDocumentCompare(props.run.id, props.candidate.id) : output()
        }
      >
        <span class="docws-candidate-head">
          <span class={`docws-dot docws-dot-${props.candidate.status}`} />
          <span class="docws-candidate-label">{props.candidate.label}</span>
          <span>{props.candidate.agentName}</span>
          <Show when={props.candidate.model || props.candidate.effort}>
            <span class="docws-candidate-model">{modelLabel(props.candidate)}</span>
          </Show>
          <Show when={props.candidate.isMain}>
            <span class="docws-badge">main</span>
          </Show>
          <span
            class="docws-candidate-state"
            classList={{ 'is-accepted': verdict() === 'accepted' }}
          >
            {candidateState(props.candidate, verdict())}
          </span>
        </span>
      </button>
      <Show when={canReview()}>
        <button
          type="button"
          class="docws-btn docws-btn-sm"
          aria-label={`View output for proposal ${props.candidate.label}`}
          onClick={output}
        >
          View output
        </button>
      </Show>
      <Show when={props.candidate.error && props.candidate.status !== 'running'}>
        <div class="docws-error">{props.candidate.error}</div>
      </Show>
      <Show when={props.showLog && tail().length > 0}>
        <div class="docws-log">{tail().join('\n')}</div>
      </Show>
    </div>
  );
}

/** The runs against the project's documents, newest first; each candidate opens its output. */
export function RunsRail() {
  const runs = createMemo(() =>
    documentStore.runOrder.map((id) => documentStore.runs[id]).filter(Boolean),
  );
  const [nowMs, setNowMs] = createSignal(Date.now());
  const clock = setInterval(() => setNowMs(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));

  return (
    <>
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
              <Show when={lineageLabel(run)}>
                {(lineage) => <div class="docws-run-meta docws-run-lineage">{lineage()}</div>}
              </Show>
              <div class="docws-run-meta" title={scopeLabel(run)}>
                <Show when={run.documentPath !== activeDocumentPath()}>
                  <span class="docws-run-doc">{run.documentPath} · </span>
                </Show>
                {scopeLabel(run)} · base {run.baseSha.slice(0, 7)}
              </div>
              <For each={run.candidates}>
                {(candidate) => (
                  <CandidateRow
                    run={run}
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
                  <RejectRunButton run={run} label={proposals() > 0 ? 'Reject all' : 'Dismiss'} />
                </Show>
              </div>
            </div>
          );
        }}
      </For>
    </>
  );
}
