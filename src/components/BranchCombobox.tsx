import {
  createSignal,
  createMemo,
  createEffect,
  createUniqueId,
  For,
  Show,
  onCleanup,
} from 'solid-js';
import { theme } from '../lib/theme';
import { filterBranches, matchExactBranch } from '../lib/branch-filter';

interface BranchComboboxProps {
  /** All selectable branches. */
  branches: string[];
  /** Currently committed branch. */
  value: string;
  /** Called when the user commits a branch from the list. */
  onChange: (branch: string) => void;
  /** Disables the input while the branch list is loading. */
  loading: boolean;
  /** Optional id, used to associate an external <label>. */
  id?: string;
}

/**
 * A type-to-filter branch picker. Replaces a native <select> so users with
 * many branches can narrow the list by typing instead of scrolling. The
 * picker only ever commits a branch that exists in `branches`.
 */
export function BranchCombobox(props: BranchComboboxProps) {
  // Seeded from `props.value` by the sync effect below once mounted.
  const [query, setQuery] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [highlight, setHighlight] = createSignal(0);
  const listId = createUniqueId();
  let inputRef!: HTMLInputElement;
  let listRef: HTMLUListElement | undefined;

  // While the dropdown is closed, mirror the committed value into the input
  // (covers the branch list loading in and setting a default base branch).
  createEffect(() => {
    const v = props.value;
    if (!open()) {
      setQuery(v);
      setDirty(false);
    }
  });

  // Once the user starts typing, filter; otherwise show every branch.
  const matches = createMemo(() =>
    dirty() ? filterBranches(props.branches, query()) : [...props.branches],
  );

  // Keep the highlighted index inside the current match list.
  createEffect(() => {
    const max = matches().length - 1;
    if (highlight() > max) setHighlight(Math.max(0, max));
  });

  // Scroll the highlighted option into view as the user arrows through.
  createEffect(() => {
    if (!open()) return;
    const node = listRef?.children[highlight()] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
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
    if (!dirty()) return;
    // Commit a fully-typed branch name; otherwise discard the partial text.
    const exact = matchExactBranch(props.branches, query());
    if (exact) commit(exact);
    else revertToValue();
  }

  function onFocus(): void {
    setOpen(true);
    const idx = props.branches.indexOf(props.value);
    setHighlight(idx >= 0 ? idx : 0);
  }

  function onInput(value: string): void {
    setQuery(value);
    setDirty(true);
    setOpen(true);
    setHighlight(0);
  }

  // Native keydown listener so Escape can stopPropagation and close only the
  // dropdown, not the parent dialog (whose Escape handler is on `document`).
  createEffect(() => {
    const el = inputRef;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open()) {
          setOpen(true);
          return;
        }
        setHighlight((h) => Math.min(matches().length - 1, h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open()) {
          setOpen(true);
          return;
        }
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === 'Enter') {
        if (open() && matches().length > 0) {
          // Stop the form from submitting on selection.
          e.preventDefault();
          commit(matches()[highlight()]);
        }
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
        aria-expanded={open()}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open() && matches().length > 0 ? `${listId}-opt-${highlight()}` : undefined
        }
        class="input-field"
        value={query()}
        placeholder={props.loading ? 'Loading branches…' : 'Search branches…'}
        disabled={props.loading}
        onInput={(e) => onInput(e.currentTarget.value)}
        onFocus={onFocus}
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
          opacity: props.loading ? '0.5' : '1',
        }}
      />
      <Show when={open() && !props.loading}>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
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
                  onMouseEnter={() => setHighlight(i())}
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
