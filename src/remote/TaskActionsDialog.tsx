import { createSignal, createResource, For, Show } from 'solid-js';
import {
  fetchMergeReadiness,
  mergeTask as mergeTaskRequest,
  closeTask as closeTaskRequest,
  ApiError,
  type ReadinessCheck,
} from './api';

interface TaskActionsDialogProps {
  taskId: string | undefined;
  taskName: string;
  /** View-only devices see the readiness summary but cannot run either action. */
  canAct: boolean;
  onClose: () => void;
  onNeedsPairing: () => void;
  /** Fired after a successful merge or close so the list can drop the task. */
  onDone: () => void;
}

type Mode = 'actions' | 'merge' | 'close' | null;

const OVERALL_COPY: Record<string, { title: string; detail: string }> = {
  ready: { title: 'Ready to merge', detail: 'Known checks passed.' },
  attention: { title: 'Needs attention', detail: 'Review these before merging.' },
  blocked: { title: 'Not ready to merge', detail: 'Resolve blockers before continuing.' },
  checking: { title: 'Checking', detail: 'Waiting for merge status.' },
};

const SYMBOL: Record<ReadinessCheck['status'], string> = {
  pass: '✓',
  warning: '!',
  blocked: '×',
  checking: '…',
  neutral: '—',
};

function statusClass(status: ReadinessCheck['status'] | string): string {
  if (status === 'pass' || status === 'ready') return 'ok';
  if (status === 'blocked') return 'bad';
  if (status === 'warning' || status === 'attention' || status === 'checking') return 'warn';
  return 'neutral';
}

/**
 * Phone-side task lifecycle: merge and close, with the desktop's readiness
 * checks shown read-only.
 *
 * The checks are advisory here exactly as on the desktop — the panel never runs
 * verification or tests, it only reports what was already known. A blocked
 * verdict disables the merge button, but a warning does not: a phone user away
 * from their desk still has to be able to merge with eyes open.
 */
export function TaskActionsDialog(props: TaskActionsDialogProps) {
  const [mode, setMode] = createSignal<Mode>(null);
  const [squash, setSquash] = createSignal(false);
  const [cleanup, setCleanup] = createSignal(false);
  // What the desktop says closing would lose; non-empty only after it refused.
  const [closeWarnings, setCloseWarnings] = createSignal<string[]>([]);
  const [closeForce, setCloseForce] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const [readiness] = createResource(
    () => props.taskId,
    (id) => fetchMergeReadiness(id),
  );

  const copy = () =>
    OVERALL_COPY[readiness()?.readiness.overall ?? 'checking'] ?? OVERALL_COPY.checking;
  const canMerge = () => readiness()?.canMerge === true;
  const baseBranch = () => readiness()?.baseBranch || 'the base branch';
  const closeCopy = () => {
    const deleteBranch = readiness()?.deleteBranchOnClose;
    if (deleteBranch === true) {
      return 'This stops the agent and deletes its worktree and branch. Commits that are not merged are lost.';
    }
    if (deleteBranch === false) {
      return 'This stops the agent and removes its worktree. The branch is kept.';
    }
    return 'This stops the agent and removes its worktree.';
  };

  function start(next: Exclude<Mode, null>) {
    setError('');
    setCloseWarnings([]);
    setCloseForce(false);
    setMode(next);
  }

  /**
   * Run an action. An action returning `false` means "handled, but the task is
   * still here" (e.g. the desktop refused a close that would lose work), so the
   * dialog stays open instead of navigating away.
   */
  async function run(action: () => Promise<boolean | undefined>) {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      if ((await action()) === false) return;
      setMode(null);
      props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmMerge() {
    const id = props.taskId;
    if (!id) return;
    // Read the signals now: inside the async callback they would be captured
    // outside the reactive scope, and the value sent could be stale.
    const options = { squash: squash(), cleanup: cleanup() };
    void run(async () => {
      await mergeTaskRequest(id, options);
      return true;
    });
  }

  function confirmClose() {
    const id = props.taskId;
    if (!id) return;
    const force = closeForce();
    void run(async () => {
      const { warnings } = await closeTaskRequest(id, force);
      if (warnings.length > 0) {
        // The desktop refused because closing would lose work. Stay on this step
        // and offer the explicit force option rather than closing silently. The
        // flag stays off: the user has to opt in, not merely retry.
        setCloseWarnings(warnings);
        return false;
      }
      setCloseForce(false);
      return true;
    });
  }

  return (
    <div class="mobile-dialog-backdrop" role="presentation">
      <div class="mobile-dialog" role="dialog" aria-modal="true" aria-label="Task actions">
        <Show when={mode() === null}>
          <h2 class="mobile-dialog-title">{props.taskName}</h2>

          <Show when={readiness.loading}>
            <p class="muted">Checking merge readiness…</p>
          </Show>
          <Show when={readiness.error}>
            <p class="mobile-error" role="alert">
              Could not check merge readiness.
            </p>
          </Show>

          <Show when={readiness()}>
            {(data) => (
              <section
                class={`mobile-readiness mobile-readiness-${statusClass(data().readiness.overall)}`}
              >
                <strong>{copy().title}</strong>
                <p class="muted">{copy().detail}</p>
                <ul class="mobile-readiness-list">
                  <For each={data().readiness.checks}>
                    {(check) => (
                      <li
                        class={`mobile-readiness-row mobile-readiness-${statusClass(check.status)}`}
                      >
                        <span class="mobile-readiness-symbol" aria-hidden="true">
                          {SYMBOL[check.status]}
                        </span>
                        <span>
                          <strong>{check.label}</strong>
                          <span class="muted"> — {check.detail}</span>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </Show>

          <Show when={!props.canAct}>
            <p class="muted">Pair this phone to merge or close tasks.</p>
          </Show>

          <div class="mobile-dialog-actions">
            <button class="mobile-button primary" onClick={() => props.onClose()}>
              Done
            </button>
            <Show when={props.canAct}>
              <button
                class="mobile-button"
                disabled={!canMerge() || readiness.loading}
                onClick={() => start('merge')}
              >
                Merge
              </button>
              <button class="mobile-button" onClick={() => start('close')}>
                Close
              </button>
            </Show>
          </div>
        </Show>

        <Show when={mode() === 'merge'}>
          <h2 class="mobile-dialog-title">Merge into {baseBranch()}</h2>
          <Show when={!canMerge()}>
            <p class="mobile-error" role="alert">
              A merge blocker must be resolved first.
            </p>
          </Show>
          <label class="mobile-dialog-option">
            <input
              type="checkbox"
              checked={squash()}
              onChange={(e) => setSquash(e.currentTarget.checked)}
            />
            Squash into one commit
          </label>
          <label class="mobile-dialog-option">
            <input
              type="checkbox"
              checked={cleanup()}
              onChange={(e) => setCleanup(e.currentTarget.checked)}
            />
            Close the task and delete its worktree afterwards
          </label>
          <Show when={error()}>
            <p class="mobile-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="mobile-dialog-actions">
            <button class="mobile-button" disabled={busy()} onClick={() => setMode(null)}>
              Cancel
            </button>
            <button
              class="mobile-button primary"
              disabled={busy() || !canMerge()}
              onClick={confirmMerge}
            >
              {busy() ? 'Merging…' : 'Merge'}
            </button>
          </div>
        </Show>

        <Show when={mode() === 'close'}>
          <h2 class="mobile-dialog-title">Close {props.taskName}?</h2>
          <p class="muted">{closeCopy()}</p>
          <Show when={error()}>
            <p class="mobile-error" role="alert">
              {error()}
            </p>
          </Show>
          <Show when={closeWarnings().length > 0}>
            <div class="mobile-error" role="alert">
              <p>Closing would lose work:</p>
              <ul>
                <For each={closeWarnings()}>{(warning) => <li>{warning}</li>}</For>
              </ul>
            </div>
            <label class="mobile-dialog-option">
              <input
                type="checkbox"
                checked={closeForce()}
                onChange={(e) => setCloseForce(e.currentTarget.checked)}
              />
              Close anyway and discard the work listed above
            </label>
          </Show>
          <div class="mobile-dialog-actions">
            <button class="mobile-button" disabled={busy()} onClick={() => setMode(null)}>
              Cancel
            </button>
            <button class="mobile-button primary" disabled={busy()} onClick={confirmClose}>
              {busy() ? 'Closing…' : 'Close task'}
            </button>
          </div>
        </Show>

        <Show when={error() && mode() === null}>
          <p class="mobile-error" role="alert">
            {error()}
          </p>
        </Show>
      </div>
    </div>
  );
}
