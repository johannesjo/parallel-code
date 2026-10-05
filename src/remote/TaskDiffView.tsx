import { createSignal, createResource, For, Show } from 'solid-js';
import { parseUnifiedDiff, type FileDiff } from '../lib/unified-diff-parser';
import { fetchTaskDiff } from './api';

/** Rejections cross the fetch boundary, so the reason is not guaranteed to be an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface TaskDiffViewProps {
  taskId: string | undefined;
  /** Bumped by the parent to force a refetch (e.g. manual refresh). */
  reloadToken?: number;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

function statusLabel(file: FileDiff): string {
  if (file.binary) return 'binary';
  const added = file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0);
  const removed = file.hunks.reduce(
    (n, h) => n + h.lines.filter((l) => l.type === 'remove').length,
    0,
  );
  if (added === 0 && removed === 0) return file.status;
  return `+${added} −${removed}`;
}

/**
 * Phone-side diff review: a file list that expands into per-file hunks.
 *
 * Reuses the desktop's pure `parseUnifiedDiff` rather than a second parser, so
 * both surfaces agree on hunk boundaries and line numbers. Deliberately omits the
 * desktop's virtualized scrolling and inline review comments — those are
 * pointer-and-keyboard features that don't survive a phone viewport.
 */
export function TaskDiffView(props: TaskDiffViewProps) {
  const [openPath, setOpenPath] = createSignal<string | null>(null);
  const [diff] = createResource(
    () => ({ taskId: props.taskId, token: props.reloadToken ?? 0 }),
    async (source) => {
      if (!source.taskId) return null;
      // Surface the server's reason (task not found, git failed, …) rather than
      // replacing every failure with one opaque string.
      return fetchTaskDiff(source.taskId);
    },
  );

  const status = (): Status => {
    if (!props.taskId) return 'idle';
    if (diff.loading) return 'loading';
    if (diff.error) return 'error';
    return 'ready';
  };

  const files = (): FileDiff[] => {
    const raw = diff()?.diff;
    return raw ? parseUnifiedDiff(raw) : [];
  };

  const truncated = () => diff()?.truncated === true;

  const unsupported = () => diff()?.unsupported === true;

  return (
    <div class="mobile-diff">
      <Show when={status() === 'loading'}>
        <p class="mobile-diff-status">Loading changes…</p>
      </Show>

      <Show when={status() === 'error'}>
        <div class="mobile-diff-status">
          <p>Could not load the diff.</p>
          <Show when={diff.error}>
            {(err) => <p class="mobile-diff-error">{errorMessage(err())}</p>}
          </Show>
        </div>
      </Show>

      <Show when={status() === 'ready' && unsupported()}>
        <p class="mobile-diff-status">
          This task works directly in the project folder, so there is no branch to compare.
        </p>
      </Show>

      <Show when={status() === 'ready' && !unsupported() && files().length === 0}>
        <p class="mobile-diff-status">No changes yet.</p>
      </Show>

      <Show when={status() === 'ready' && !unsupported() && files().length > 0}>
        <Show when={truncated()}>
          <p class="mobile-diff-truncated">
            This diff is too large for the phone; showing the start.
          </p>
        </Show>
        <ul class="mobile-diff-files">
          <For each={files()}>
            {(file) => {
              const expanded = () => openPath() === file.path;
              return (
                <li class="mobile-diff-file">
                  <button
                    class="mobile-diff-file-head"
                    aria-expanded={expanded()}
                    onClick={() => setOpenPath(expanded() ? null : file.path)}
                  >
                    <span class="mobile-diff-path">{file.path}</span>
                    <span class="mobile-diff-stat">{statusLabel(file)}</span>
                  </button>
                  <Show when={expanded()}>
                    <Show
                      when={!file.binary}
                      fallback={<p class="mobile-diff-binary">Binary file not shown.</p>}
                    >
                      <For each={file.hunks}>
                        {(hunk) => (
                          <pre class="mobile-diff-hunk">
                            <code>
                              <span class="mobile-diff-hunk-head">
                                @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount}{' '}
                                @@
                              </span>
                              <For each={hunk.lines}>
                                {(line) => (
                                  <span
                                    class={`mobile-diff-line mobile-diff-line-${line.type}`}
                                    data-sign={
                                      line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '
                                    }
                                  >
                                    {line.content}
                                  </span>
                                )}
                              </For>
                            </code>
                          </pre>
                        )}
                      </For>
                    </Show>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}
