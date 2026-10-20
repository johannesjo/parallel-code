import { For, Show, createResource, createSignal, onCleanup } from 'solid-js';
import { listGitHubWorkItems } from '../store/github';
import { errMessage } from '../lib/log';
import { theme, bannerStyle } from '../lib/theme';
import type { GitHubWorkItem } from '../ipc/types';

const SEARCH_DEBOUNCE_MS = 400;

interface GitHubItemPickerProps {
  projectRoot: string;
  onPick: (item: GitHubWorkItem) => void;
  /** Marks items that are already taken (e.g. on the Kanban board) and disables them. */
  pickedLabel?: (item: GitHubWorkItem) => string | null;
  /** Without its own frame, for use inside a popover that already has one. */
  bare?: boolean;
  autofocus?: boolean;
}

/** Lists the project repo's open issues and PRs, searchable through `gh --search`. */
export function GitHubItemPicker(props: GitHubItemPickerProps) {
  const [search, setSearch] = createSignal('');
  let debounce: number | undefined;
  onCleanup(() => clearTimeout(debounce));

  const [items] = createResource(
    () => ({ root: props.projectRoot, q: search() }),
    ({ root, q }) => listGitHubWorkItems(root, q || undefined),
  );

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '6px',
        ...(props.bare
          ? {}
          : {
              padding: '8px',
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-md)',
              background: theme.bgInput,
            }),
      }}
    >
      <input
        ref={(el) => {
          if (props.autofocus) queueMicrotask(() => el.focus());
        }}
        class="input-field"
        type="search"
        aria-label="Search issues and pull requests"
        placeholder="Search open issues and pull requests…"
        onInput={(e) => {
          const value = e.currentTarget.value.trim();
          clearTimeout(debounce);
          debounce = window.setTimeout(() => setSearch(value), SEARCH_DEBOUNCE_MS);
        }}
        style={{
          background: 'transparent',
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-sm)',
          padding: '6px 10px',
          color: theme.fg,
          'font-size': '13px',
          outline: 'none',
        }}
      />
      <Show when={items.error}>
        {(err) => (
          <div role="alert" style={{ ...bannerStyle(theme.error), 'font-size': '12px' }}>
            {/* Electron wraps IPC errors in its own prefix; the cause is what helps. */}
            {errMessage(err()).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}
          </div>
        )}
      </Show>
      <Show when={items.loading}>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>Loading from GitHub…</span>
      </Show>
      <Show when={!items.loading && !items.error && items()?.length === 0}>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
          No open issues or pull requests found.
        </span>
      </Show>
      <ul
        aria-label="Open issues and pull requests"
        style={{
          'list-style': 'none',
          margin: '0',
          padding: '0',
          'max-height': '220px',
          'overflow-y': 'auto',
        }}
      >
        <For each={items.error ? [] : (items() ?? [])}>
          {(item) => (
            <li>
              <button
                type="button"
                class="github-item-option"
                // aria-disabled, not disabled: a picked item keeps focus for the next pick.
                aria-disabled={props.pickedLabel?.(item) ? true : undefined}
                onClick={() => {
                  if (!props.pickedLabel?.(item)) props.onPick(item);
                }}
                title={item.url}
                style={{
                  display: 'flex',
                  gap: '8px',
                  'align-items': 'baseline',
                  width: '100%',
                  padding: '5px 6px',
                  background: 'transparent',
                  border: 'none',
                  'border-radius': 'var(--radius-sm)',
                  color: theme.fg,
                  'font-size': '13px',
                  'text-align': 'left',
                  cursor: props.pickedLabel?.(item) ? 'default' : 'pointer',
                  opacity: props.pickedLabel?.(item) ? '0.6' : '1',
                }}
              >
                <span
                  style={{
                    'flex-shrink': '0',
                    'font-size': '11px',
                    'font-weight': '600',
                    color: item.kind === 'pr' ? theme.accent : theme.success,
                  }}
                >
                  {item.kind === 'pr' ? (item.isDraft ? 'Draft PR' : 'PR') : 'Issue'}
                </span>
                <span style={{ 'flex-shrink': '0', color: theme.fgMuted }}>#{item.number}</span>
                <span
                  style={{
                    flex: '1',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {item.title}
                </span>
                <span style={{ 'flex-shrink': '0', 'font-size': '11px', color: theme.fgMuted }}>
                  {props.pickedLabel?.(item) ?? item.author}
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
