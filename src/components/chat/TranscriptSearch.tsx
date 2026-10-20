import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import type { ChatItem } from '../../../electron/shared/agent-chat-types';
import { SearchIcon } from '../icons';

const speakers = { user: 'You', shell: 'Shell', tool: 'Activity', assistant: 'Assistant' };

/** Everything an entry shows, including what a collapsed row hides: a command
 *  and its output, the files it touched and the lines an edit changed. */
function searchable(item: ChatItem): string {
  const activity = item.activity;
  return [
    activity?.command ?? activity?.label,
    item.text,
    ...(activity?.files ?? []),
    ...(activity?.diffs ?? []).flatMap((diff) => [diff.path, diff.diff]),
  ]
    .filter(Boolean)
    .join('\n');
}

function focusQuery(input: HTMLInputElement) {
  input.focus();
  input.select();
}

/** Finds text in messages and tool output, including what collapsed activity hides.
 *  Floating, it has no button: the host opens it (Ctrl/Cmd+F) through `onControls`,
 *  and it closes once focus leaves it. */
export function TranscriptSearch(props: {
  items: ChatItem[];
  onJump: (id: string) => void;
  floating?: boolean;
  onControls?: (open: () => void) => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  let input: HTMLInputElement | undefined;
  const needle = () => query().trim().toLocaleLowerCase();
  const matches = createMemo(() => {
    const wanted = needle();
    // A closed panel keeps its query for reopening, but must not rescan the whole
    // transcript on every streamed frame.
    if (!open() || !wanted) return [];
    return props.items.flatMap((item) => {
      const text = searchable(item);
      return text.toLocaleLowerCase().includes(wanted) ? [{ item, text }] : [];
    });
  });
  const excerpt = (text: string) => {
    const start = Math.max(0, text.toLocaleLowerCase().indexOf(needle()) - 40);
    return text.slice(start, start + 180);
  };
  const close = () => {
    setOpen(false);
    props.onClose?.();
  };
  onMount(() =>
    props.onControls?.(() => {
      setOpen(true);
      // Already open: take the caret back and select the last query for retyping.
      if (input) focusQuery(input);
    }),
  );
  return (
    <div
      class="chat-search"
      classList={{ 'chat-search-floating': props.floating }}
      onFocusOut={(event) => {
        if (props.floating && !event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <Show when={!props.floating}>
        <button class="btn-with-icon" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <SearchIcon size={12} />
          Search conversation
        </button>
      </Show>
      <Show when={open()}>
        <div class="chat-search-panel">
          <input
            ref={(element) => {
              input = element;
              queueMicrotask(() => focusQuery(element));
            }}
            aria-label="Search conversation"
            placeholder="Find in messages and output…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
            }}
          />
          <Show when={needle()}>
            <span role="status">{matches().length} matching messages</span>
          </Show>
          <div class="chat-search-results">
            <For each={matches()}>
              {(match) => (
                <button onClick={() => props.onJump(match.item.id)}>
                  <strong>{speakers[match.item.kind]}</strong> {excerpt(match.text)}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
