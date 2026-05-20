import {
  createSignal,
  createMemo,
  createEffect,
  createUniqueId,
  onMount,
  onCleanup,
  For,
  Show,
} from 'solid-js';
import { theme } from '../lib/theme';
import { clampHighlight, filterBranches, resolveOnBlur } from '../lib/branch-filter';

interface BranchComboboxProps {
  /** All selectable branches. */
  branches: string[];
  /** Currently committed branch. */
  value: string;
  /** Called when the user commits a branch from the list. */
  onChange: (branch: string) => void;
  /** Disables the input while the branch list is loading. Defaults to false. */
  loading?: boolean;
  /** Optional id, used to associate an external <label>. */
  id?: string;
}

/** Longest git ref names in practice; bounds per-keystroke work on paste. */
const MAX_QUERY_LENGTH = 255;

/**
 * A type-to-filter branch picker. Replaces a native <select> so users with
 * many branches can narrow the list by typing instead of scrolling. The
 * picker only ever commits a branch that exists in `branches`.
 */
export function BranchCombobox(props: BranchComboboxProps) {
  // Typed text. Only consulted for display while the dropdown is open;
  // `display` falls back to the committed value when closed.
  const [query, setQuery] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [highlight, setHighlight] = createSignal(0);
  const listId = createUniqueId();
  let inputRef!: HTMLInputElement;
  let listRef: HTMLUListElement | undefined;
  // True when the highlight last moved by keyboard — gates auto-scroll so a
  // hovering mouse does not yank the list (or the dialog) under the cursor.
  let keyboardNav = false;

  const isLoading = () => props.loading ?? false;

  // Shown text is derived, never written back: closed → the committed value,
  // open/dirty → the user's typed text. Avoids a stale signal when `value`
  // changes externally (e.g. a branch-list refetch on project switch).
  const display = createMemo(() => (open() || dirty() ? query() : props.value));

  // Once the user starts typing, filter; otherwise show every branch.
  const matches = createMemo(() =>
    dirty() ? filterBranches(props.branches, query()) : [...props.branches],
  );

  // Keep the highlighted index inside the current match list.
  createEffect(() => {
    const count = matches().length;
    setHighlight((h) => clampHighlight(h, count));
  });

  // Scroll the highlighted option into view for keyboard navigation only,
  // moving the listbox's own scrollTop so the outer dialog never scrolls.
  createEffect(() => {
    const idx = highlight();
    if (!open() || !keyboardNav) return;
    const list = listRef;
    const node = list?.children[idx] as HTMLElement | undefined;
    if (!list || !node || matches().length === 0) return;
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  });

  function commit(branch: string): void {
    props.onChange(branch);
    setQuery(branch);
    setDirty(false);
    setOpen(false);
  }

  function revertToValue(): void {
    setQuery(props.value);
    setDirty(false);
  }

  function closeAndResolve(): void {
    setOpen(false);
    // Commit a fully-typed branch name; otherwise discard the partial text.
    // When the resolved branch equals the committed value there is nothing
    // to commit, so just revert the typed text — same end state, no onChange.
    const resolved = resolveOnBlur(props.branches, query(), dirty(), props.value);
    if (resolved !== props.value) commit(resolved);
    else revertToValue();
  }

  // Open the list with an empty query so the first keystroke starts a fresh
  // filter instead of appending to the committed branch name (typing "feature"
  // must not turn "main" into "mainfeature"). Seeding empty — rather than
  // selecting the seeded text — avoids relying on input.select() inside a
  // focus handler, which a mouse click's caret placement on mouseup overrides.
  // `dirty` stays false so the list shows every branch until the user types.
  function openList(): void {
    keyboardNav = true;
    setQuery('');
    setDirty(false);
    setOpen(true);
    const idx = props.branches.indexOf(props.value);
    setHighlight(idx >= 0 ? idx : 0);
  }

  // Mouse commits keep focus on the input (the option uses mousedown +
  // preventDefault), so a later focus event never fires. Reopen on click.
  function onClick(): void {
    if (open()) return;
    openList();
  }

  function onInput(value: string): void {
    keyboardNav = true;
    setQuery(value);
    setDirty(true);
    setOpen(true);
    setHighlight(0);
  }

  // Native keydown listener so Escape can stopPropagation and close only the
  // dropdown, not the parent dialog (whose Escape handler is on `document`).
  onMount(() => {
    const el = inputRef;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        keyboardNav = true;
        // Opening via arrow key seeds query/highlight the same way focus and
        // click do, so the list always opens on the committed branch.
        if (!open()) {
          openList();
          return;
        }
        setHighlight((h) => clampHighlight(h + 1, matches().length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        keyboardNav = true;
        if (!open()) {
          openList();
          return;
        }
        setHighlight((h) => clampHighlight(h - 1, matches().length));
      } else if (e.key === 'Enter') {
        // Always swallow Enter: a branch field must never submit the form.
        e.preventDefault();
        if (open() && matches().length > 0) commit(matches()[highlight()]);
        else closeAndResolve();
      } else if (e.key === 'Escape' && open()) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        revertToValue();
      }
    };
    el.addEventListener('keydown', handler);
    onCleanup(() => el.removeEventListener('keydown', handler));
  });

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        id={props.id}
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck={false}
        maxlength={MAX_QUERY_LENGTH}
        aria-expanded={open()}
        aria-controls={open() ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          open() && matches().length > 0 ? `${listId}-opt-${highlight()}` : undefined
        }
        class="input-field"
        value={display()}
        placeholder={isLoading() ? 'Loading branches…' : 'Search branches…'}
        disabled={isLoading()}
        onInput={(e) => onInput(e.currentTarget.value)}
        onFocus={openList}
        onClick={onClick}
        onBlur={closeAndResolve}
        style={{
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          'border-radius': '8px',
          padding: '10px 14px',
          color: theme.fg,
          'font-size': '14px',
          'font-family': "'JetBrains Mono', monospace",
          outline: 'none',
          width: '100%',
          'box-sizing': 'border-box',
          opacity: isLoading() ? '0.5' : '1',
        }}
      />
      <Show when={open() && !isLoading()}>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Branches"
          // Keep clicks on padding/scrollbar from blurring the input.
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: '0',
            right: '0',
            'z-index': '30',
            margin: '0',
            padding: '4px',
            'list-style': 'none',
            'max-height': '200px',
            'overflow-y': 'auto',
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            'box-shadow': '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          <Show
            when={matches().length > 0}
            fallback={
              <li style={{ padding: '8px 12px', color: theme.fgMuted, 'font-size': '13px' }}>
                No matching branches
              </li>
            }
          >
            <For each={matches()}>
              {(branch, i) => (
                <li
                  id={`${listId}-opt-${i()}`}
                  role="option"
                  aria-selected={branch === props.value}
                  // mousedown (not click) fires before the input's blur, so
                  // the selection commits before the dropdown closes.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(branch);
                  }}
                  onMouseEnter={() => {
                    keyboardNav = false;
                    setHighlight(i());
                  }}
                  style={{
                    padding: '8px 12px',
                    'border-radius': '6px',
                    cursor: 'pointer',
                    'font-size': '13px',
                    'font-family': "'JetBrains Mono', monospace",
                    color: theme.fg,
                    'white-space': 'nowrap',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    background:
                      i() === highlight()
                        ? theme.bgHover
                        : branch === props.value
                          ? theme.bgSelectedSubtle
                          : 'transparent',
                  }}
                >
                  {branch}
                </li>
              )}
            </For>
          </Show>
        </ul>
      </Show>
    </div>
  );
}
