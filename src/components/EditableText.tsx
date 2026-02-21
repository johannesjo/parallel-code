import { createSignal, onMount, Show } from 'solid-js';
import { theme } from '../lib/theme';

export interface EditableTextHandle {
  startEdit: () => void;
}

interface EditableTextProps {
  value: string;
  onCommit: (newValue: string) => void;
  placeholder?: string;
  class?: string;
  ref?: (handle: EditableTextHandle) => void;
}

export function EditableText(props: EditableTextProps) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');

  function startEdit() {
    setDraft(props.value);
    setEditing(true);
  }

  onMount(() => {
    props.ref?.({ startEdit });
  });

  function commit() {
    const val = draft().trim();
    setEditing(false);
    if (val && val !== props.value) {
      props.onCommit(val);
    }
  }

  function cancel() {
    setEditing(false);
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span
          class={props.class}
          onDblClick={startEdit}
          style={{
            cursor: 'default',
            'white-space': 'nowrap',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'min-width': '0',
          }}
        >
          {props.value || props.placeholder}
        </span>
      }
    >
      <input
        class="editable-text-input"
        ref={(el) => requestAnimationFrame(() => el.focus())}
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') cancel();
        }}
        onBlur={commit}
        style={{
          background: theme.bgInput,
          border: `1px solid ${theme.borderFocus}`,
          'border-radius': '4px',
          padding: '2px 6px',
          color: theme.fg,
          'font-size': 'inherit',
          'font-family': 'inherit',
          'font-weight': 'inherit',
          outline: 'none',
          width: '100%',
          'min-width': '0',
        }}
      />
    </Show>
  );
}
