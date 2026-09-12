import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { ChangedFile } from '../../electron/ipc/shared-types';
import { filterBranches, clampHighlight } from '../lib/branch-filter';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

interface CanvasFilePickerProps {
  worktreePath: string;
  /** Files on the canvas already, marked in the list. */
  current?: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}

export interface PickerSection {
  title: string;
  files: string[];
}

const isMarkdown = (p: string): boolean => /\.(md|markdown)$/i.test(p);

/** Changed files first, then the rest of the worktree; a filter narrows both. */
export function pickerSections(all: string[], changed: string[], query: string): PickerSection[] {
  const changedSet = new Set(changed);
  const rest = all.filter((f) => !changedSet.has(f));
  return [
    { title: 'Changed in this task', files: filterBranches(changed, query) },
    { title: 'All Markdown files', files: filterBranches(rest, query) },
  ].filter((s) => s.files.length > 0);
}

/**
 * The file list under the canvas header: a filter box, the Markdown files
 * this task changed, then every other Markdown file of the worktree. Arrow
 * keys and Enter pick; Escape or a click outside closes.
 */
export function CanvasFilePicker(props: CanvasFilePickerProps) {
  const [all, setAll] = createSignal<string[]>([]);
  const [changed, setChanged] = createSignal<string[]>([]);
  const [query, setQuery] = createSignal('');
  const [highlight, setHighlight] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const sections = createMemo(() => pickerSections(all(), changed(), query()));
  const flat = createMemo(() => sections().flatMap((s) => s.files));

  onMount(() => {
    void Promise.all([
      invoke<string[]>(IPC.ListDocumentFiles, { projectRoot: props.worktreePath }).catch(
        () => [] as string[],
      ),
      invoke<ChangedFile[]>(IPC.GetUncommittedChangedFiles, {
        worktreePath: props.worktreePath,
      }).catch(() => [] as ChangedFile[]),
    ]).then(([files, changedFiles]) => {
      setAll(files.filter(isMarkdown));
      setChanged(changedFiles.map((f) => f.path).filter(isMarkdown));
      setLoaded(true);
    });
    const onPointerDown = (e: MouseEvent) => {
      if (root && !root.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    onCleanup(() => document.removeEventListener('mousedown', onPointerDown));
  });

  function onKeyDown(e: KeyboardEvent): void {
    const count = flat().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => clampHighlight(h + 1, count));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => clampHighlight(h - 1, count));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = flat()[clampHighlight(highlight(), count)];
      if (pick) props.onPick(pick);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  }

  const indexOf = (file: string) => flat().indexOf(file);

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Choose a Markdown file"
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        top: '100%',
        left: '6px',
        right: '6px',
        'z-index': '30',
        'margin-top': '2px',
        background: theme.bgElevated,
        border: `1px solid ${theme.border}`,
        'border-radius': 'var(--radius-md)',
        'box-shadow': '0 8px 24px rgba(0,0,0,0.4)',
        display: 'flex',
        'flex-direction': 'column',
        'max-height': 'min(360px, 60vh)',
      }}
    >
      <input
        ref={(el) => queueMicrotask(() => el.focus())}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck={false}
        placeholder="Filter files…"
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setHighlight(0);
        }}
        style={{
          margin: '6px',
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-sm)',
          padding: '5px 8px',
          color: theme.fg,
          'font-size': sf(12),
          'font-family': "'JetBrains Mono', monospace",
          outline: 'none',
        }}
      />
      <div role="listbox" style={{ overflow: 'auto', padding: '0 4px 4px' }}>
        <Show
          when={sections().length > 0}
          fallback={
            <div style={{ padding: '6px 8px', color: theme.fgMuted, 'font-size': sf(12) }}>
              {loaded() ? 'No Markdown files match.' : 'Loading…'}
            </div>
          }
        >
          <For each={sections()}>
            {(section) => (
              <>
                <div
                  style={{
                    padding: '6px 8px 2px',
                    color: theme.fgSubtle,
                    'font-size': sf(10),
                    'text-transform': 'uppercase',
                    'letter-spacing': '0.04em',
                  }}
                >
                  {section.title}
                </div>
                <For each={section.files}>
                  {(file) => (
                    <div
                      role="option"
                      aria-selected={props.current?.includes(file) === true}
                      onMouseEnter={() => setHighlight(indexOf(file))}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        props.onPick(file);
                      }}
                      style={{
                        padding: '4px 8px',
                        'border-radius': 'var(--radius-sm)',
                        cursor: 'pointer',
                        color: props.current?.includes(file) ? theme.fg : theme.fgMuted,
                        background: indexOf(file) === highlight() ? theme.bgHover : 'transparent',
                        'font-size': sf(12),
                        'font-family': "'JetBrains Mono', monospace",
                        'white-space': 'nowrap',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                      }}
                    >
                      {file}
                    </div>
                  )}
                </For>
              </>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
