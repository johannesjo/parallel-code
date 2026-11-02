import './Delegation.css';
import { Show, createUniqueId } from 'solid-js';
import { clearTaskLandingReview } from '../store/tasks';
import type { Task } from '../store/types';
import { CompletionReport } from './CompletionReport';
import { Dialog } from './Dialog';
import { DialogFooter } from './DialogFooter';
import { CheckIcon } from './icons';

/** A child that landed itself stays visible here until the user marks its result reviewed. */
export function DelegationReviewDialog(props: { task: Task; open: boolean; onClose: () => void }) {
  const titleId = createUniqueId();
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} width="850px" labelledBy={titleId}>
      <div class="delegation-surface">
        <h2 id={titleId}>Review merged changes: {props.task.name}</h2>
        <p>
          This result has already been merged. Mark it reviewed when you have checked the result.
        </p>
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
      </div>
      <DialogFooter>
        <button type="button" class="btn-secondary" onClick={() => props.onClose()}>
          Close
        </button>
        <Show when={props.task.landingState === 'landed_pending_review'}>
          <button
            type="button"
            class="btn-primary btn-with-icon"
            onClick={() => {
              clearTaskLandingReview(props.task.id);
              props.onClose();
            }}
          >
            <CheckIcon size={14} />
            Mark reviewed
          </button>
        </Show>
      </DialogFooter>
    </Dialog>
  );
}
