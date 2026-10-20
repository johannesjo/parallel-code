import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { DocumentCandidateRecord, DocumentRunRecord } from './types';
import { refineDocumentCandidate } from './store';
import { errMessage } from '../lib/log';
import { registerCompareForm } from './workspace-ui';
import { SparkleIcon } from '../components/icons';

export function CandidateRefinement(props: {
  run: DocumentRunRecord;
  candidate: DocumentCandidateRecord;
  /** The toggle's wording; the compare view's default names the candidate. */
  label?: string;
}) {
  let toggle: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [feedback, setFeedback] = createSignal('');
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal('');
  const available = () =>
    props.candidate.status === 'done' &&
    !!props.candidate.commitSha &&
    (props.run.status === 'finished' || props.run.status === 'stale');

  async function refine() {
    if (!available() || !feedback().trim() || starting()) return;
    setStarting(true);
    setError('');
    try {
      await refineDocumentCandidate(props.run, props.candidate, feedback().trim());
      setOpen(false);
      setFeedback('');
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setStarting(false);
    }
  }

  function close() {
    setOpen(false);
    toggle?.focus();
  }

  // Registered while open, so Escape reaches the form from anywhere in the dialog.
  createEffect(() => {
    if (!open()) return;
    onCleanup(registerCompareForm(close));
  });

  // Bound natively so the key stops here: the compare dialog listens on the
  // document and would take the same Escape as its own and close over the form.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  }

  return (
    <Show when={available()}>
      <button
        ref={toggle}
        type="button"
        class="docws-btn docws-btn-sm"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
        disabled={starting()}
      >
        <SparkleIcon size={12} />
        {props.label ?? 'Refine this candidate'}
      </button>
      <Show when={open()}>
        <div class="docws-refinement" on:keydown={onKeyDown}>
          <textarea
            class="docws-note"
            aria-label="Refinement feedback"
            placeholder="What should change in this candidate?"
            ref={(el) => queueMicrotask(() => el.focus())}
            value={feedback()}
            onInput={(e) => setFeedback(e.currentTarget.value)}
            disabled={starting()}
          />
          <Show when={error()}>
            <p class="docws-error" role="alert">
              {error()}
            </p>
          </Show>
          <button
            type="button"
            class="docws-btn docws-btn-sm docws-btn-primary"
            disabled={!feedback().trim() || starting()}
            onClick={() => void refine()}
          >
            <SparkleIcon size={12} />
            {starting() ? 'Starting…' : 'Generate revision'}
          </button>
        </div>
      </Show>
    </Show>
  );
}
