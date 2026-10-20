import { createSignal } from 'solid-js';
import { ConfirmDialog } from './ConfirmDialog';
import { detachFromParent } from '../store/delegation';

/** Lets the user end a parent/child link so the two tasks stop messaging each other. */
export function DetachFromParentButton(props: { taskId: string; parentName: string }) {
  const [confirming, setConfirming] = createSignal(false);
  const [detaching, setDetaching] = createSignal(false);
  const [error, setError] = createSignal('');

  async function detach() {
    setDetaching(true);
    setError('');
    try {
      await detachFromParent(props.taskId);
      setConfirming(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setDetaching(false);
    }
  }

  return (
    <>
      <button
        class="delegation-button"
        title="Stop this task and its parent from communicating"
        onClick={(event) => {
          event.stopPropagation();
          setError('');
          setConfirming(true);
        }}
      >
        Detach
      </button>
      <ConfirmDialog
        open={confirming()}
        title="Detach from parent?"
        message={
          <>
            <p>
              This task becomes a standalone task. It keeps its branch, worktree and running agent,
              but it and "{props.parentName}" can no longer message, wait for or merge each other.
            </p>
            <p>This cannot be undone.</p>
            <p role="alert" style={{ visibility: error() ? 'visible' : 'hidden' }}>
              {error() || ' '}
            </p>
          </>
        }
        confirmLabel="Detach"
        confirmLoading={detaching()}
        onConfirm={() => void detach()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
