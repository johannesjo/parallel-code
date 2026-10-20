import { Show, type Resource, createMemo, createResource, createSignal } from 'solid-js';
import { CandidateRefinement } from './CandidateRefinement';
import { fetchDocumentAt } from './CompareView';
import { DocumentViewer } from './DocumentViewer';
import { RejectRunButton } from './RejectRunConfirm';
import { acceptDocumentCandidate, openDocumentCompareModal } from './store';
import { blockHunks, trackedBlocks } from './block-merge';
import { diffBlocks } from './markdown-blocks';
import { createRenderedBlocks } from './use-blocks';
import { errMessage } from '../lib/log';
import { countLabel } from '../lib/plural';
import type { DocumentCandidateRecord, DocumentRunRecord } from './types';

/** A resource's value once ready; reading an errored one would throw. */
function loaded(resource: Resource<string | null>): string | null {
  return resource.state === 'ready' ? (resource() ?? null) : null;
}

/**
 * The only proposal of a run, read in the document itself as tracked changes:
 * what it drops stays in place, struck through, among what it adds. Deciding
 * here is what the compare view's Apply does with every change kept; picking
 * single changes stays in the compare view, one click away.
 */
export function InlineReview(props: {
  run: DocumentRunRecord;
  candidate: DocumentCandidateRecord;
}) {
  const [base] = createResource(
    () => ({ sha: props.run.baseSha, path: props.run.documentPath }),
    ({ sha, path }) => fetchDocumentAt(sha, path),
  );
  const [proposal] = createResource(
    () => ({ sha: props.candidate.commitSha ?? '', path: props.run.documentPath }),
    ({ sha, path }) => fetchDocumentAt(sha, path),
  );
  const baseBlocks = createRenderedBlocks(() => loaded(base));
  const candBlocks = createRenderedBlocks(() => loaded(proposal));
  const diff = createMemo(() => diffBlocks(baseBlocks.blocks(), candBlocks.blocks()));
  const changeCount = () => blockHunks(diff()).length;
  // A page keeps its own markup, which cannot hold struck-through base blocks:
  // it shows the proposal alone, with its changes marked.
  const tracked = createMemo(() =>
    candBlocks.page()
      ? { blocks: candBlocks.blocks(), changes: diff().candidate }
      : trackedBlocks(baseBlocks.blocks(), candBlocks.blocks(), diff()),
  );
  const [accepting, setAccepting] = createSignal(false);
  // Both sides must have loaded: diffing against a missing base would show the
  // whole proposal as added, and Accept on null content would apply nothing real.
  const ready = () =>
    !base.loading &&
    !proposal.loading &&
    !base.error &&
    !proposal.error &&
    typeof loaded(base) === 'string' &&
    typeof loaded(proposal) === 'string';
  const loadError = () => {
    if (base.error || proposal.error) return errMessage(base.error ?? proposal.error);
    if (!base.loading && !proposal.loading && !ready()) return 'The proposal could not be read.';
    return null;
  };
  const canAccept = () => ready() && props.run.status === 'finished' && !accepting();

  async function accept() {
    if (!canAccept()) return;
    setAccepting(true);
    try {
      await acceptDocumentCandidate(props.run.id, props.candidate.id);
    } finally {
      setAccepting(false);
    }
  }

  return (
    <section class="docws-inline-review" aria-label="Proposal review">
      <div class="docws-inline-review-bar">
        {/* A stale run says why Accept is off where the summary was, so the
            buttons stay where they are. */}
        <span
          class="docws-inline-review-summary"
          classList={{ 'docws-warning': props.run.status === 'stale' }}
          title={props.candidate.rationale?.summary}
        >
          {props.run.status === 'stale'
            ? 'The document moved since this run; re-run it to apply.'
            : (props.candidate.rationale?.summary ?? 'Proposal ready')}
        </span>
        <Show when={changeCount() > 1}>
          <span class="docws-inline-review-count">{countLabel(changeCount(), 'change')}</span>
        </Show>
        <button
          type="button"
          class="docws-btn docws-btn-sm docws-btn-primary"
          disabled={!canAccept()}
          title={
            props.run.status === 'stale'
              ? 'The document moved since this run and the proposal no longer applies. Re-run it.'
              : 'Apply this proposal to your document'
          }
          onClick={() => void accept()}
        >
          {accepting() ? 'Applying…' : 'Accept'}
        </button>
        <RejectRunButton run={props.run} label="Reject" />
        <CandidateRefinement run={props.run} candidate={props.candidate} label="Refine…" />
        <button
          type="button"
          class="docws-btn docws-btn-sm"
          onClick={() => openDocumentCompareModal(props.run.id, props.candidate.id)}
        >
          Open side by side
        </button>
      </div>
      <Show when={loadError()}>
        {(message) => (
          <div class="docws-empty" role="alert">
            {message()}
          </div>
        )}
      </Show>
      <Show
        when={ready() && (!candBlocks.rendering() || candBlocks.blocks().length > 0)}
        fallback={
          <Show when={!loadError()}>
            <div class="docws-empty">Rendering…</div>
          </Show>
        }
      >
        <DocumentViewer
          blocks={tracked().blocks}
          changes={tracked().changes}
          renderKey={`inline-${props.candidate.id}`}
          page={candBlocks.page()}
        />
      </Show>
    </section>
  );
}
