import { createMemo, createSignal, createUniqueId, For, Show } from 'solid-js';
import type { MapNode } from '../graph/model';
import { searchRecords } from './navigate';

/** Finds notes by title or saved text and hands the chosen one back for locating. */
export function GraphSearch<N extends MapNode>(props: {
  records: N[];
  kindLabel?: (node: N) => string | undefined;
  onPick: (id: string) => void;
}) {
  let wrapper!: HTMLDivElement;
  const listId = createUniqueId();
  const [query, setQuery] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const results = createMemo(() => searchRecords(props.records, query()));
  const listOpen = () => open() && !!query().trim();
  // Results shrink under agent updates; the highlight stays on a real row.
  const activeIndex = () => Math.min(active(), Math.max(results().length - 1, 0));
  function pick(id: string) {
    setOpen(false);
    props.onPick(id);
  }
  function keydown(event: KeyboardEvent) {
    // Enter and arrows pick and move among IME candidates until the composition ends.
    if (event.isComposing) return;
    const count = results().length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      setOpen(true);
      // Step from the row on screen, not the raw index. After an agent update shrinks the
      // results the two differ, and wrapping the stale one swallows a keypress or skips a row.
      setActive(() => (activeIndex() + 1) % count);
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      setActive(() => (activeIndex() - 1 + count) % count);
    } else if (event.key === 'Enter' && listOpen()) {
      const hit = results()[activeIndex()];
      if (!hit) return;
      event.preventDefault();
      pick(hit.id);
    } else if (event.key === 'Escape' && query()) {
      // A first Escape only clears the search; the graph keeps its own Escape for the next one.
      event.stopPropagation();
      setQuery('');
      setOpen(false);
    }
  }
  return (
    <div
      ref={wrapper}
      class="reasoning-graph-search"
      onFocusOut={(event) => {
        if (!wrapper.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        type="search"
        role="combobox"
        aria-label="Find nodes"
        placeholder="Find…"
        aria-expanded={listOpen()}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          listOpen() && results().length ? `${listId}-${activeIndex()}` : undefined
        }
        value={query()}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={keydown}
      />
      <Show when={listOpen()}>
        <div
          id={listId}
          role={results().length ? 'listbox' : 'status'}
          class="reasoning-graph-search-results"
          aria-label="Matching notes"
        >
          <For
            each={results()}
            fallback={<p class="reasoning-graph-search-empty">No matching notes</p>}
          >
            {(node, index) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${index()}`}
                tabIndex={-1}
                aria-selected={index() === activeIndex()}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index())}
                onClick={() => pick(node.id)}
              >
                <span class="reasoning-graph-search-title">{node.title || 'Untitled'}</span>
                <Show when={props.kindLabel?.(node)}>{(label) => <small>{label()}</small>}</Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
