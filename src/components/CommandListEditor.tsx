import { createSignal, For, Show } from 'solid-js';
import { theme } from '../lib/theme';

export interface CommandVariable {
  name: string;
  description: string;
  example: string;
}

interface CommandListEditorProps {
  label: string;
  description?: string;
  placeholder: string;
  items: string[];
  onAdd: (item: string) => void;
  onRemove: (index: number) => void;
  variables?: CommandVariable[];
}

export function CommandListEditor(props: CommandListEditorProps) {
  const [newItem, setNewItem] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  function add() {
    const v = newItem().trim();
    if (!v) return;
    props.onAdd(v);
    setNewItem('');
  }

  function insertVariable(varName: string) {
    if (!inputRef) return;
    const token = `$${varName}`;
    const start = inputRef.selectionStart ?? inputRef.value.length;
    const end = inputRef.selectionEnd ?? start;
    const before = inputRef.value.slice(0, start);
    const after = inputRef.value.slice(end);
    const updated = before + token + after;
    setNewItem(updated);
    // Restore cursor position after the inserted token
    requestAnimationFrame(() => {
      inputRef?.focus();
      const pos = start + token.length;
      inputRef?.setSelectionRange(pos, pos);
    });
  }

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <label
        style={{
          'font-size': '11px',
          color: theme.fgMuted,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
        }}
      >
        {props.label}
      </label>
      <Show when={props.description}>
        <span style={{ 'font-size': '11px', color: theme.fgSubtle }}>{props.description}</span>
      </Show>
      <Show when={props.items.length > 0}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <For each={props.items}>
            {(item, i) => (
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  padding: '4px 8px',
                  background: theme.bgInput,
                  'border-radius': '6px',
                  border: `1px solid ${theme.border}`,
                }}
              >
                <span
                  style={{
                    flex: '1',
                    'font-size': '11px',
                    'font-family': "'JetBrains Mono', monospace",
                    color: theme.fgSubtle,
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {item}
                </span>
                <button
                  type="button"
                  onClick={() => props.onRemove(i())}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: theme.fgSubtle,
                    cursor: 'pointer',
                    padding: '2px',
                    'line-height': '1',
                    'flex-shrink': '0',
                  }}
                  title="Remove"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                  </svg>
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div style={{ display: 'flex', gap: '6px' }}>
        <input
          ref={inputRef}
          class="input-field"
          type="text"
          value={newItem()}
          onInput={(e) => setNewItem(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={props.placeholder}
          style={{
            flex: '1',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            padding: '8px 12px',
            color: theme.fg,
            'font-size': '12px',
            'font-family': "'JetBrains Mono', monospace",
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!newItem().trim()}
          style={{
            padding: '8px 14px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            color: newItem().trim() ? theme.fg : theme.fgSubtle,
            cursor: newItem().trim() ? 'pointer' : 'not-allowed',
            'font-size': '12px',
            'flex-shrink': '0',
          }}
        >
          Add
        </button>
      </div>
      <Show when={props.variables && props.variables.length > 0}>
        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px', 'align-items': 'center' }}>
          <span style={{ 'font-size': '10px', color: theme.fgSubtle }}>Variables:</span>
          <For each={props.variables}>
            {(v) => <VariableChip variable={v} onInsert={() => insertVariable(v.name)} />}
          </For>
        </div>
      </Show>
    </div>
  );
}

function VariableChip(props: { variable: CommandVariable; onInsert: () => void }) {
  const [showTooltip, setShowTooltip] = createSignal(false);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onClick={(e) => {
          e.preventDefault();
          props.onInsert();
        }}
        style={{
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          'border-radius': '4px',
          padding: '2px 6px',
          color: theme.accent,
          cursor: 'pointer',
          'font-size': '10px',
          'font-family': "'JetBrains Mono', monospace",
          'line-height': '1.4',
        }}
      >
        {'$' + props.variable.name}
      </button>
      <Show when={showTooltip()}>
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '0',
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            padding: '8px 10px',
            'z-index': '1000',
            'white-space': 'nowrap',
            'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
            display: 'flex',
            'flex-direction': 'column',
            gap: '4px',
          }}
        >
          <span style={{ 'font-size': '11px', color: theme.fg }}>{props.variable.description}</span>
          <span
            style={{
              'font-size': '10px',
              color: theme.fgSubtle,
              'font-family': "'JetBrains Mono', monospace",
            }}
          >
            e.g. {props.variable.example}
          </span>
        </div>
      </Show>
    </div>
  );
}
