import { createResource, createSignal, Show } from 'solid-js';
import { ApiError, fetchFixCiPrompt, sendFixCiPrompt } from './api';

/** Matches the desktop route's cap: several failed jobs with their log tails. */
const MAX_PROMPT_CHARS = 60_000;

function errorText(err: unknown): string {
  // Desktops from before this route answer 404 for the unknown path.
  if (err instanceof ApiError && err.status === 404)
    return 'Update Parallel Code on your computer to fix CI from here.';
  return err instanceof Error ? err.message : String(err);
}

/**
 * Phone-side Fix CI: loads the desktop's failed-checks prompt into an editable
 * field and sends it to the agent only when the user says so. The log tails
 * come from GitHub, so like the desktop's staged prompt they are read first.
 */
export function FixCiDialog(props: { taskId: string; onClose: () => void }) {
  const [prompt] = createResource(
    () => props.taskId,
    (id) => fetchFixCiPrompt(id),
  );
  const [text, setText] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  // Reading an errored resource throws, so only read it once it has loaded.
  const loaded = () => (prompt.state === 'ready' ? prompt() : undefined);
  const value = () => text() ?? loaded() ?? '';

  async function send() {
    setBusy(true);
    setError('');
    try {
      await sendFixCiPrompt(props.taskId, value());
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mobile-dialog-backdrop" role="presentation">
      <div class="mobile-dialog" role="dialog" aria-modal="true" aria-label="Fix CI">
        <h2 class="mobile-dialog-title">Fix CI</h2>
        <Show when={prompt.loading}>
          <p class="muted">Collecting failed checks…</p>
        </Show>
        <Show when={prompt.error}>
          <p class="mobile-error" role="alert">
            {errorText(prompt.error)}
          </p>
        </Show>
        <Show when={loaded() === null}>
          <p class="muted">No failed checks found.</p>
        </Show>
        <Show when={loaded()}>
          <p class="muted">The logs come from GitHub. Read them before sending.</p>
          <textarea
            class="mobile-input mobile-fix-ci-prompt"
            rows={12}
            maxlength={MAX_PROMPT_CHARS}
            aria-label="Fix CI prompt"
            value={value()}
            disabled={busy()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </Show>
        <Show when={error()}>
          <p class="mobile-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="mobile-dialog-actions">
          <button class="mobile-button" disabled={busy()} onClick={() => props.onClose()}>
            Cancel
          </button>
          <Show when={loaded()}>
            <button
              class="mobile-button primary"
              disabled={busy() || !value().trim()}
              onClick={() => void send()}
            >
              {busy() ? 'Sending…' : 'Send to agent'}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
