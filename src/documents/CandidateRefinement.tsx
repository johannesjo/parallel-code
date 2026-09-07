import { Show, createSignal } from 'solid-js';
import type { DocumentCandidateRecord, DocumentRunRecord } from './types';
import { refineDocumentCandidate } from './store';
import { errMessage } from '../lib/log';

export function CandidateRefinement(props: {
  run: DocumentRunRecord;
  candidate: DocumentCandidateRecord;
}) {
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

  return (
    <Show when={available()}>
      <button
        type="button"
        class="docws-btn docws-btn-sm"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
        disabled={starting()}
      >
        Refine this candidate
      </button>
      <Show when={open()}>
        <div class="docws-refinement">
          <p>
            Revise this whole proposal with the same agent and model. Your document stays unchanged.
          </p>
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
            {starting() ? 'Starting…' : 'Generate revision'}
          </button>
        </div>
      </Show>
    </Show>
  );
}
