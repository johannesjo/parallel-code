import { createSignal } from 'solid-js';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { rejectDocumentRun } from './store';
import type { DocumentRunRecord } from './types';

/** Runs whose rejection is under way, so a second click cannot start it twice. */
const [rejecting, setRejecting] = createSignal<ReadonlySet<string>>(new Set<string>());

async function reject(runId: string): Promise<void> {
  setRejecting((prev) => new Set(prev).add(runId));
  try {
    await rejectDocumentRun(runId);
  } finally {
    setRejecting((prev) => {
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
  }
}

/**
 * The button that throws a run's proposals away, with the confirmation that
 * deserves: rejecting deletes the candidates' branches and worktrees, and
 * nothing brings them back. A run that produced no proposal is only
 * dismissed, which needs no second thought.
 */
export function RejectRunButton(props: { run: DocumentRunRecord; label: string }) {
  const [confirming, setConfirming] = createSignal(false);
  const proposals = () => props.run.candidates.filter((c) => c.commitSha).length;
  const busy = () => rejecting().has(props.run.id);

  function confirm() {
    setConfirming(false);
    void reject(props.run.id);
  }

  return (
    <>
      <button
        type="button"
        class="docws-btn docws-btn-sm docws-btn-danger"
        disabled={busy()}
        onClick={() => (proposals() > 0 ? setConfirming(true) : void reject(props.run.id))}
      >
        {props.label}
      </button>
      <ConfirmDialog
        open={confirming()}
        title={proposals() > 1 ? 'Reject all proposals?' : 'Reject this proposal?'}
        message={
          proposals() > 1
            ? `The ${proposals()} proposals and their branches are deleted. Your document stays as it is.`
            : 'The proposal and its branch are deleted. Your document stays as it is.'
        }
        confirmLabel="Reject"
        danger
        onConfirm={confirm}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
