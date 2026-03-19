import { createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';

interface Entry {
  name: string;
  isDir: boolean;
}

interface PathSelectorProps {
  dirs: string[];
  projectRoot: string | undefined;
  onAdd: (dir: string) => void;
  onRemove: (index: number) => void;
}

export function PathSelector(props: PathSelectorProps) {
  const [query, setQuery] = createSignal('');
  const [showSuggestions, setShowSuggestions] = createSignal(false);
  const [selectedIdx, setSelectedIdx] = createSignal(-1);
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [dropdownPos, setDropdownPos] = createSignal({ top: 0, left: 0, width: 0 });
  let inputRef!: HTMLInputElement;
  let suppressBlur = false;

  // Split query into directory prefix and filter part
  const queryParts = () => {
    const q = query();
    const lastSlash = q.lastIndexOf('/');
    if (lastSlash === -1) return { prefix: '', filter: q };
    return { prefix: q.slice(0, lastSlash + 1), filter: q.slice(lastSlash + 1) };
  };

  // Fetch entries when prefix changes
  createEffect(() => {
    const root = props.projectRoot;
    if (!root) {
      setEntries([]);
      return;
    }
    const { prefix } = queryParts();
    const subpath = prefix ? prefix.replace(/\/$/, '') : undefined;
    let cancelled = false;

    void (async () => {
      try {
        const result = await invoke<Entry[]>(IPC.ListProjectEntries, {
          projectRoot: root,
          subpath,
        });
        if (!cancelled) setEntries(result);
      } catch {
        if (!cancelled) setEntries([]);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const filtered = createMemo(() => {
    const { prefix, filter } = queryParts();
    const f = filter.toLowerCase();
    const added = new Set(props.dirs);
    return entries()
      .filter((e) => {
        const fullPath = prefix + e.name;
        return !added.has(fullPath) && (!f || e.name.toLowerCase().includes(f));
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => ({ ...e, fullPath: prefix + e.name }));
  });

  function updateDropdownPos() {
    if (!inputRef) return;
    const rect = inputRef.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 2, left: rect.left, width: rect.width });
  }

  function addDir(name: string) {
    const trimmed = name.trim().replace(/\/$/, '');
    if (!trimmed || props.dirs.includes(trimmed)) return;
    props.onAdd(trimmed);
    setQuery('');
    setShowSuggestions(false);
    setSelectedIdx(-1);
    inputRef?.focus();
  }

  function selectItem(item: { fullPath: string; isDir: boolean }) {
    if (item.isDir) {
      setQuery(item.fullPath + '/');
      setSelectedIdx(-1);
      setShowSuggestions(true);
      updateDropdownPos();
    } else {
      addDir(item.fullPath);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const items = filtered();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Tab') {
      const idx = selectedIdx();
      const item = idx >= 0 && idx < items.length ? items[idx] : items[0];
      if (item) {
        e.preventDefault();
        suppressBlur = true;
        selectItem(item);
        requestAnimationFrame(() => {
          inputRef?.focus();
          suppressBlur = false;
        });
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const idx = selectedIdx();
      if (idx >= 0 && idx < items.length) {
        selectItem(items[idx]);
      } else if (query().trim()) {
        addDir(query());
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSelectedIdx(-1);
    }
  }

  return (
    <div
      data-nav-field="symlink-dirs"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
    >
      <label
        style={{
          'font-size': '11px',
          color: theme.fgMuted,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
        }}
      >
        Symlink into worktree
      </label>
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '4px',
          padding: '8px 10px',
          background: theme.bgElevated,
          'border-radius': '6px',
          border: `1px solid ${theme.border}`,
        }}
      >
        <For each={props.dirs}>
          {(dir, index) => (
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'font-size': '12px',
                'font-family': "'JetBrains Mono', monospace",
                color: theme.fg,
                padding: '2px 0',
              }}
            >
              <span
                style={{
                  flex: '1',
                  'min-width': '0',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}
              >
                {dir}
              </span>
              <button
                type="button"
                onClick={() => props.onRemove(index())}
                style={{
                  background: 'none',
                  border: 'none',
                  color: theme.fgSubtle,
                  cursor: 'pointer',
                  padding: '0 4px',
                  'font-size': '14px',
                  'line-height': '1',
                  'flex-shrink': '0',
                }}
                title="Remove"
              >
                ×
              </button>
            </div>
          )}
        </For>
        <div style={{ 'margin-top': '4px' }}>
          <input
            ref={inputRef}
            class="input-field"
            type="text"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setShowSuggestions(true);
              setSelectedIdx(-1);
              updateDropdownPos();
            }}
            onFocus={() => {
              updateDropdownPos();
              setShowSuggestions(true);
            }}
            onBlur={() => {
              if (suppressBlur) return;
              setTimeout(() => setShowSuggestions(false), 150);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Add path…"
            style={{
              width: '100%',
              'box-sizing': 'border-box',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '6px',
              padding: '6px 10px',
              color: theme.fg,
              'font-size': '11px',
              'font-family': "'JetBrains Mono', monospace",
              outline: 'none',
            }}
          />
          <Show when={showSuggestions() && filtered().length > 0}>
            <div
              style={{
                position: 'fixed',
                top: `${dropdownPos().top}px`,
                left: `${dropdownPos().left}px`,
                width: `${dropdownPos().width}px`,
                background: theme.bgElevated,
                border: `1px solid ${theme.border}`,
                'border-radius': '6px',
                'max-height': '160px',
                'overflow-y': 'auto',
                'z-index': '9999',
                'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
              }}
            >
              <For each={filtered()}>
                {(item, index) => (
                  <div
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectItem(item);
                      inputRef?.focus();
                    }}
                    style={{
                      padding: '6px 10px',
                      'font-size': '11px',
                      'font-family': "'JetBrains Mono', monospace",
                      color: theme.fg,
                      cursor: 'pointer',
                      background: index() === selectedIdx() ? theme.bgInput : 'transparent',
                      display: 'flex',
                      'align-items': 'center',
                      gap: '6px',
                    }}
                    onMouseEnter={() => setSelectedIdx(index())}
                  >
                    <span
                      style={{
                        color: theme.fgSubtle,
                        'font-size': '10px',
                        width: '14px',
                        'text-align': 'center',
                        'flex-shrink': '0',
                      }}
                    >
                      {item.isDir ? '/' : ''}
                    </span>
                    <span>{item.name}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
