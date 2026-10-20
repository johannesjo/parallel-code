import { createSignal, createEffect, onMount, onCleanup, For, Show } from 'solid-js';
import { fetchProjects, createTask, ApiError, type MobileProject } from './api';
import { clearPairedToken } from './auth';
import { readLocal, writeLocal } from './storage';
import { status } from './ws';
import { ConnectionBanner } from './ConnectionBanner';

interface NewTaskScreenProps {
  onCreated: (taskId: string, name: string) => void;
  onCancel: () => void;
  onNeedsPairing: () => void;
}

export function NewTaskScreen(props: NewTaskScreenProps) {
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const [projects, setProjects] = createSignal<MobileProject[]>([]);
  const [projectId, setProjectId] = createSignal(readLocal('project'));
  const [name, setName] = createSignal(readLocal('new-name'));
  const [prompt, setPrompt] = createSignal(readLocal('new-prompt'));
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const title = () => name().trim() || prompt().trim().replace(/\s+/g, ' ').slice(0, 80);
  const agentName = () => projects().find((p) => p.id === projectId())?.agentName;
  createEffect(() => writeLocal('project', projectId()));
  createEffect(() => writeLocal('new-name', name()));
  createEffect(() => writeLocal('new-prompt', prompt()));

  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      clearPairedToken();
      props.onNeedsPairing();
      return true;
    }
    return false;
  }

  async function loadProjects() {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchProjects();
      if (disposed) return;
      setProjects(list);
      if (!list.some((p) => p.id === projectId())) setProjectId(list[0]?.id ?? '');
    } catch (err) {
      if (disposed) return;
      if (!handleAuthError(err))
        setError(err instanceof Error ? err.message : 'Could not load projects');
    } finally {
      if (!disposed) setLoading(false);
    }
  }
  onMount(() => void loadProjects());
  const canSubmit = () =>
    !!projectId() && !!prompt().trim() && !busy() && !loading() && status() === 'connected';

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!canSubmit()) return;
    const taskName = title();
    const draftPrompt = prompt();
    const draftName = name();
    setBusy(true);
    setError(null);
    try {
      const taskId = await createTask({
        projectId: projectId(),
        name: taskName,
        prompt: draftPrompt.trim(),
      });
      if (readLocal('new-prompt') === draftPrompt && readLocal('new-name') === draftName) {
        writeLocal('new-name', '');
        writeLocal('new-prompt', '');
      }
      if (!disposed) {
        setName('');
        setPrompt('');
        props.onCreated(taskId, taskName);
      }
    } catch (err) {
      if (disposed) return;
      if (!handleAuthError(err))
        setError(
          `${err instanceof Error ? err.message : 'Could not create task'}. Your draft is saved. If the connection was interrupted, check the task list before retrying.`,
        );
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  return (
    <div class="mobile-screen">
      <header class="mobile-header">
        <button class="mobile-button quiet" onClick={() => props.onCancel()} disabled={busy()}>
          Back
        </button>
        <div class="heading">
          <h1>New task</h1>
          <p>Start work on your computer, from here.</p>
        </div>
      </header>
      <ConnectionBanner />
      <main class="mobile-scroll">
        <form id="new-task" class="mobile-form" onSubmit={handleSubmit} aria-busy={busy()}>
          <Show when={loading()}>
            <p class="muted" role="status">
              Loading your projects…
            </p>
          </Show>
          <label>
            Project
            <select
              class="mobile-input"
              value={projectId()}
              onChange={(e) => setProjectId(e.currentTarget.value)}
              disabled={loading() || busy()}
            >
              <Show when={!projects().length}>
                <option value="">
                  {loading() ? 'Loading projects…' : 'No projects available'}
                </option>
              </Show>
              <For each={projects()}>
                {(p) => (
                  <option value={p.id} selected={p.id === projectId()}>
                    {p.name}
                  </option>
                )}
              </For>
            </select>
          </label>
          <Show when={projectId() && !loading()}>
            <p class="mobile-project-hint muted">
              {agentName() ? `Runs with ${agentName()}` : 'Runs with your default agent'} · Desktop
              settings
            </p>
          </Show>
          <Show when={!loading() && !projects().length && !error()}>
            <p class="muted">Add a project in Parallel Code on your computer, then retry.</p>
          </Show>
          <Show when={error()}>
            <p class="mobile-error" role="alert">
              {error()}
            </p>
          </Show>
          <Show when={!loading() && !projects().length}>
            <button type="button" class="mobile-button" onClick={() => void loadProjects()}>
              Retry loading projects
            </button>
          </Show>
          <label>
            What should the agent work on?
            <textarea
              class="mobile-input"
              placeholder="Fix the login redirect and add a regression test…"
              rows={7}
              maxlength={16000}
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              disabled={busy()}
            />
          </label>
          <details class="mobile-title-options" open={!!readLocal('new-name')}>
            <summary>
              Custom title <span class="muted">Optional</span>
            </summary>
            <label>
              Custom title{' '}
              <input
                class="mobile-input"
                maxlength={200}
                placeholder="Leave empty to use your message"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                disabled={busy()}
              />
            </label>
          </details>
          <p class="muted">
            A title is created from your message unless you set one. Your draft is saved on this
            phone.
          </p>
        </form>
      </main>
      <footer class="mobile-footer">
        <button
          class="mobile-button primary wide"
          type="submit"
          form="new-task"
          disabled={!canSubmit()}
        >
          {busy() ? 'Creating task…' : 'Start task'}
        </button>
      </footer>
    </div>
  );
}
