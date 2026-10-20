import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { FileTreePanel } from './FileTreePanel';
import { openDocumentFile } from './store';
import { setFilesOpen, workspaceUi } from './workspace-ui';

/** A filter on a long project must not render thousands of rows. */
const MAX_MATCHES = 200;

interface FilesPopoverProps {
  projectRoot: string;
  /** Repo-relative path of the open document, shown as the button's label. */
  openPath: string | undefined;
  /** Files opened lately, newest first; the open one is left out of the list. */
  recentPaths: readonly string[];
}

/** The document switcher: the open path in the header; opens a filter, recent files and the tree. */
export function FilesPopover(props: FilesPopoverProps) {
  const open = () => workspaceUi.filesOpen;
  const [query, setQuery] = createSignal('');
  const [active, setActive] = createSignal(0);
  let anchor: HTMLDivElement | undefined;

  const filtering = () => query().trim() !== '';
  const recent = createMemo(() => props.recentPaths.filter((p) => p !== props.openPath));
  // The rows the arrow keys walk: matches while filtering, else the recent files.
  const items = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (q === '') return recent();
    return workspaceUi.files.filter((p) => p.toLowerCase().includes(q)).slice(0, MAX_MATCHES);
  });

  function close() {
    setFilesOpen(false);
  }
  function pick(path: string) {
    void openDocumentFile(path);
    close();
  }
  function onPointerDown(e: MouseEvent) {
    if (!anchor?.contains(e.target as Node)) close();
  }
  function onEscape(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // The popover owns Escape while open; the workspace must stay up.
    e.stopPropagation();
    close();
  }
  // Listening only while open keeps Escape free for the rest of the workspace.
  createEffect(() => {
    if (!open()) return;
    setQuery('');
    setActive(0);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onEscape, true);
    onCleanup(() => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onEscape, true);
    });
  });
  onCleanup(close);

  function onFilterKeyDown(e: KeyboardEvent) {
    const count = items().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (count > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const path = items()[active()];
      if (path !== undefined) pick(path);
    }
  }

  function Row(rowProps: { path: string; index: number }) {
    const isActive = () => active() === rowProps.index;
    return (
      <button
        type="button"
        role="option"
        id={`docws-switch-${rowProps.index}`}
        class="docws-tree-row is-document"
        classList={{ 'is-active': isActive() }}
        aria-selected={isActive()}
        title={rowProps.path}
        ref={(el) =>
          createEffect(() => {
            if (isActive()) el.scrollIntoView?.({ block: 'nearest' });
          })
        }
        onMouseEnter={() => setActive(rowProps.index)}
        onClick={() => pick(rowProps.path)}
      >
        <span class="docws-tree-name">{rowProps.path}</span>
      </button>
    );
  }

  return (
    <div class="docws-files-anchor" ref={anchor}>
      <button
        type="button"
        class="docws-file-path"
        title={`Switch document · ${props.openPath ?? ''}`}
        aria-label={`Switch document: ${props.openPath ?? ''}`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setFilesOpen(!open())}
      >
        <span>{props.openPath}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <path d="m5 6 3 3 3-3" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="docws-files-popover" role="dialog" aria-label="Switch document">
          <input
            type="text"
            class="docws-files-filter"
            placeholder="Filter files…"
            aria-label="Filter files"
            aria-controls="docws-switch-list"
            aria-activedescendant={items().length > 0 ? `docws-switch-${active()}` : undefined}
            value={query()}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onFilterKeyDown}
          />
          <Show when={filtering() || recent().length > 0}>
            <div class="docws-files-section">
              <Show when={!filtering()}>
                <div class="docws-rail-title">Recent</div>
              </Show>
              <div
                id="docws-switch-list"
                role="listbox"
                aria-label={filtering() ? 'Matches' : 'Recent'}
              >
                <For each={items()}>{(path, i) => <Row path={path} index={i()} />}</For>
              </div>
              <Show when={filtering() && items().length === 0}>
                <div class="docws-empty" style={{ padding: '4px 10px' }}>
                  No matching files.
                </div>
              </Show>
            </div>
          </Show>
          {/* Hidden, not unmounted, while filtering so the file list stays loaded. */}
          <div class="docws-files-body" style={{ display: filtering() ? 'none' : undefined }}>
            <FileTreePanel projectRoot={props.projectRoot} onOpen={close} />
          </div>
        </div>
      </Show>
    </div>
  );
}
