import { createSignal, createUniqueId, onCleanup, untrack } from 'solid-js';

interface TitleDraft {
  id: string;
  title: string;
  base: string;
  selectAll: boolean;
}

/** Shared canvas interaction; each document owns its persistence and conflict policy. */
export function createInlineEditing(options: {
  label: string;
  visible: () => boolean;
  read: (id: string) => { title: string; base: string } | undefined;
  onStart: (id: string) => void;
  onChange?: (draft: TitleDraft) => void;
  onSave: (draft: TitleDraft) => boolean;
  onCancel: (id: string) => void;
  onFinish: (id: string) => void;
  onAdd: (id: string, placement: 'child' | 'sibling') => void;
}) {
  const [editing, setEditing] = createSignal<TitleDraft>();
  const hintId = createUniqueId();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  function save() {
    const draft = editing();
    if (!draft) return true;
    if (!options.onSave(draft)) return false;
    setEditing(undefined);
    return true;
  }
  function edit(id: string, title?: string) {
    if (editing()?.id === id) return;
    if (!save()) return;
    const value = options.read(id);
    if (!value) return;
    options.onStart(id);
    const draft = { id, ...value, title: title ?? value.title, selectAll: title === undefined };
    setEditing(draft);
    options.onChange?.(draft);
  }
  function keydown(id: string, event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      options.onAdd(id, event.key === 'Enter' ? 'sibling' : 'child');
      return true;
    }
    // Zoom keys belong to the canvas; every other printable key starts a replacement title.
    if (event.key === 'F2' || (event.key.length === 1 && !' +-='.includes(event.key))) {
      event.preventDefault();
      event.stopPropagation();
      edit(id, event.key === 'F2' ? undefined : event.key);
      return true;
    }
    return false;
  }
  return {
    editing,
    edit,
    save,
    keydown,
    reset: () => setEditing(undefined),
    renderEditor: (id: string) => (
      <div class="mindmap-title-editor">
        <textarea
          class="mindmap-title-input"
          aria-label={options.label}
          aria-describedby={hintId}
          rows={3}
          maxLength={200}
          ref={(input) =>
            queueMicrotask(() => {
              if (disposed || !untrack(options.visible) || !input.isConnected) return;
              input.focus({ preventScroll: true });
              if (untrack(editing)?.selectAll) input.select();
              else input.setSelectionRange(input.value.length, input.value.length);
            })
          }
          value={editing()?.title ?? ''}
          onInput={(event) => {
            const draft = editing();
            if (!draft) return;
            const next = { ...draft, title: event.currentTarget.value };
            setEditing(next);
            options.onChange?.(next);
          }}
          onBlur={() => {
            if (!disposed && options.visible() && editing()?.id === id) save();
          }}
          onKeyDown={(event) => {
            // Let the app's Alt+Arrow pane navigation leave the editor.
            if (event.altKey) return;
            event.stopPropagation();
            if (event.isComposing) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(undefined);
              options.onCancel(id);
            } else if (
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))
            ) {
              event.preventDefault();
              if (event.key === 'Enter') {
                if (save()) options.onFinish(id);
              } else options.onAdd(id, 'child');
            }
          }}
        />
        <span id={hintId} class="mindmap-title-hint">
          Enter saves · Tab saves and adds a child · Esc cancels
        </span>
      </div>
    ),
  };
}
