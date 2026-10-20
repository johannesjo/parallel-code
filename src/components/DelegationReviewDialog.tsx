import './Delegation.css';
import { Show } from 'solid-js';
import { clearTaskLandingReview } from '../store/tasks';
import type { Task } from '../store/types';
import { CompletionReport } from './CompletionReport';
import { Dialog } from './Dialog';
import { CheckIcon } from './icons';

/** A child that landed itself stays visible here until the user marks its result reviewed. */
export function DelegationReviewDialog(props: { task: Task; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} width="850px">
      <div class="delegation-surface">
        <h2>Review merged changes: {props.task.name}</h2>
        <p>This result has already been merged.</p>
        <p>
          {props.task.landedMetadata?.summary ??
            props.task.landingSummary ??
            'No result summary was recorded.'}
        </p>
        <Show when={props.task.landedMetadata}>
          {(metadata) => (
            <p>
              <code>{metadata().landedCommit}</code> → <code>{metadata().targetBranch}</code>
            </p>
          )}
        </Show>
        <section aria-label="Agent completion report">
          <h3>Latest agent completion report</h3>
          <CompletionReport task={props.task} />
        </section>
        <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
          <button onClick={() => props.onClose()}>Close</button>
          <Show when={props.task.landingState === 'landed_pending_review'}>
            <button
              class="btn-with-icon"
              onClick={() => {
                clearTaskLandingReview(props.task.id);
                props.onClose();
              }}
            >
              <CheckIcon size={14} />
              Mark reviewed
            </button>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
