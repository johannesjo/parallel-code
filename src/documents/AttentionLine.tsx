import { Show, createMemo } from 'solid-js';
import { activeDocumentPath, openDocumentCompare, reviewableRuns } from './store';
import { isDocumentAgentWaiting } from './agent-task';
import { setRailTab } from './workspace-ui';

/**
 * What waits for the reader, said in the document itself: the side panel
 * starts collapsed, so a proposal or a question there would go unseen.
 * Compact and neutral on purpose; the panel's tabs carry the louder flags.
 */
export function AttentionLine(props: { projectId: string }) {
  // Runs of other documents are reached from the Runs tab, not announced here.
  const runs = createMemo(() =>
    reviewableRuns().filter((r) => r.documentPath === activeDocumentPath()),
  );
  const proposals = () =>
    runs().reduce((n, run) => n + run.candidates.filter((c) => c.commitSha).length, 0);
  const asking = () => isDocumentAgentWaiting(props.projectId);
  return (
    <Show when={runs().length > 0 || asking()}>
      <div class="docws-attention" role="region" aria-label="Waiting for you">
        <Show when={runs().length > 0}>
          <div class="docws-attention-row">
            <span>
              {proposals()} proposal{proposals() === 1 ? '' : 's'} ready
            </span>
            <button
              type="button"
              class="docws-btn docws-btn-sm"
              onClick={() => {
                const first = runs()[0];
                if (first) openDocumentCompare(first.id);
              }}
            >
              Review
            </button>
          </div>
        </Show>
        <Show when={asking()}>
          <div class="docws-attention-row">
            <span>Agent is asking a question</span>
            <button
              type="button"
              class="docws-btn docws-btn-sm"
              onClick={() => setRailTab('agent')}
            >
              Show
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
