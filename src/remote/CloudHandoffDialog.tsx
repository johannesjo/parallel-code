import { createResource, createSignal, Show } from 'solid-js';
import { ApiError, fetchCloudHandoff, startCloudHandoff } from './api';

/** Matches the desktop route's cap: the prompt becomes one command-line argument. */
const MAX_PROMPT_CHARS = 8_000;

function errorText(err: unknown): string {
  // Desktops from before this route refuse the unknown paired-token path with 403.
  if (err instanceof ApiError && (err.status === 403 || err.status === 404))
    return 'Update Parallel Code on your computer to continue in the cloud from here.';
  return err instanceof Error ? err.message : String(err);
}

/**
 * Phone-side "Continue in cloud": the desktop's default prompt in an editable field,
 * and the same push-first option. The desktop pushes, then runs the cloud session in a
 * terminal of the task; the phone cannot show that terminal, so it says where to follow it.
 */
export function CloudHandoffDialog(props: { taskId: string; onClose: () => void }) {
  const [handoff] = createResource(
    () => props.taskId,
    (id) => fetchCloudHandoff(id),
  );
  const [text, setText] = createSignal<string>();
  const [push, setPush] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [started, setStarted] = createSignal(false);
  const [error, setError] = createSignal('');
  // Reading an errored resource throws, so only read it once it has loaded.
  const loaded = () => (handoff.state === 'ready' ? handoff() : undefined);
  const ready = () => {
    const value = loaded();
    return value?.available ? value : undefined;
  };
  const unavailable = () => {
    const value = loaded();
    return value && !value.available ? value.reason : undefined;
  };
  const prompt = () => text() ?? ready()?.prompt ?? '';

  async function start() {
    const info = ready();
    if (!info) return;
    setBusy(true);
    setError('');
    try {
      await startCloudHandoff(props.taskId, { prompt: prompt(), push: info.canPush && push() });
      setStarted(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mobile-dialog-backdrop" role="presentation">
      <div class="mobile-dialog" role="dialog" aria-modal="true" aria-label="Continue in cloud">
        <h2 class="mobile-dialog-title">Continue in cloud</h2>
        <Show when={handoff.loading}>
          <p class="muted">Checking the task…</p>
        </Show>
        <Show when={handoff.error}>
          <p class="mobile-error" role="alert">
            {errorText(handoff.error)}
          </p>
        </Show>
        <Show when={unavailable()}>{(reason) => <p class="muted">{reason()}</p>}</Show>
        <Show when={started()}>
          <p>
            The cloud session is starting on your computer. Follow it in the Claude app or on
            claude.ai/code. The local agent keeps running.
          </p>
        </Show>
        <Show when={!started() && ready()}>
          {(info) => (
            <>
              <p class="muted">
                Starts a Claude Code session on claude.ai from {info().branchName}. When it clones
                from GitHub, only pushed commits reach it. Without a remote or the Claude GitHub
                App, Claude Code uploads the local repository instead, including uncommitted changes
                to tracked files. The local agent keeps running.
              </p>
              <textarea
                class="mobile-input"
                rows={6}
                maxlength={MAX_PROMPT_CHARS}
                aria-label="Prompt for the cloud session"
                value={prompt()}
                disabled={busy()}
                onInput={(e) => setText(e.currentTarget.value)}
              />
              <Show when={info().canPush}>
                <label class="mobile-dialog-option">
                  <input
                    type="checkbox"
                    checked={push()}
                    disabled={busy()}
                    onChange={(e) => setPush(e.currentTarget.checked)}
                  />
                  Push {info().branchName} to origin first
                </label>
              </Show>
            </>
          )}
        </Show>
        <Show when={error()}>
          <p class="mobile-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="mobile-dialog-actions">
          <button class="mobile-button" disabled={busy()} onClick={() => props.onClose()}>
            {started() ? 'Done' : 'Cancel'}
          </button>
          <Show when={!started() && ready()}>
            <button
              class="mobile-button primary"
              disabled={busy() || !prompt().trim()}
              onClick={() => void start()}
            >
              {busy() ? 'Starting…' : 'Start cloud session'}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
