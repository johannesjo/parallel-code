import { For, Show, batch, createEffect, createSignal, onCleanup } from 'solid-js';
import { validateChatImages, type ChatImage } from '../../../electron/shared/agent-chat-types';
import { CheckIcon } from '../icons';

export async function readChatImages(files: File[]): Promise<ChatImage[]> {
  if (files.length > 4 || files.reduce((size, file) => size + file.size, 0) > 6 * 1024 * 1024)
    throw new Error('Attach up to four images, totaling less than 6 MB.');
  return validateChatImages(
    await Promise.all(
      files.map(async (file) => {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        return {
          name: file.name,
          mediaType: file.type,
          data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        };
      }),
    ),
  );
}

/** Files and images the next message carries. The worktree file search opens from
 *  the composer (typing `@`), not from a button; images arrive by paste or drop. */
export function ChatContext(props: {
  files: string[];
  images: ChatImage[];
  disabled: boolean;
  open: boolean;
  onFiles: (files: string[]) => void;
  onRemoveImage: (index: number) => void;
  onClose: () => void;
  onListFiles?: () => Promise<string[]>;
}) {
  const [all, setAll] = createSignal<string[]>([]);
  const [query, setQuery] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  // Each opening lists the files afresh; a listing that lands after closing is dropped.
  createEffect(() => {
    if (!props.open) return;
    let live = true;
    onCleanup(() => (live = false));
    batch(() => {
      setQuery('');
      setLoading(true);
      setError('');
    });
    (props.onListFiles?.() ?? Promise.resolve([]))
      .then((files) => live && setAll(files))
      .catch((err: unknown) => live && setError(String(err)))
      .finally(() => live && setLoading(false));
  });
  const matches = () =>
    all().filter((file) => file.toLocaleLowerCase().includes(query().toLocaleLowerCase()));
  const toggle = (file: string) =>
    props.onFiles(
      props.files.includes(file)
        ? props.files.filter((entry) => entry !== file)
        : [...props.files, file],
    );
  return (
    <div class="chat-context">
      <Show when={props.open}>
        <div class="chat-file-picker">
          <input
            ref={(element) => queueMicrotask(() => element.focus())}
            aria-label="Find a file to attach"
            placeholder="Search worktree files…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') props.onClose();
            }}
          />
          <Show when={!loading()} fallback={<p>Loading files…</p>}>
            <Show when={!error()} fallback={<p role="alert">{error()}</p>}>
              <div>
                <For each={matches().slice(0, 100)}>
                  {(file) => (
                    <button
                      disabled={props.disabled}
                      aria-pressed={props.files.includes(file)}
                      onClick={() => toggle(file)}
                    >
                      {props.files.includes(file) ? '✓ ' : ''}
                      {file}
                    </button>
                  )}
                </For>
              </div>
              <small>
                {matches().length > 100
                  ? 'Showing the first 100 matches. Refine your search.'
                  : `${matches().length} files`}
              </small>
            </Show>
          </Show>
          <button class="btn-with-icon" onClick={() => props.onClose()}>
            <CheckIcon size={12} />
            Done
          </button>
        </div>
      </Show>
      <div class="chat-context-chips">
        <For each={props.files}>
          {(file) => (
            <button
              disabled={props.disabled}
              title={`Remove ${file}`}
              onClick={() => props.onFiles(props.files.filter((entry) => entry !== file))}
            >
              {file} ×
            </button>
          )}
        </For>
        <For each={props.images}>
          {(image, index) => (
            <button
              disabled={props.disabled}
              title={`Remove ${image.name}`}
              onClick={() => props.onRemoveImage(index())}
            >
              <img src={`data:${image.mediaType};base64,${image.data}`} alt="" />
              {image.name} ×
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
