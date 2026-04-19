import { For, Show, createSignal, onCleanup, createEffect } from 'solid-js';
import { Dialog } from './Dialog';
import { confirm as appConfirm } from '../lib/dialog';
import { theme } from '../lib/theme';
import { isMac } from '../lib/platform';
import { PRESETS } from '../lib/keybindings';
import type { KeyBinding, Modifiers } from '../lib/keybindings';
import { store } from '../store/store';
import {
  allBindings,
  selectPreset,
  setUserOverride,
  clearUserOverride,
  resetAllBindings,
  checkConflict,
} from '../store/keybindings';

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

function formatKeyCombo(binding: KeyBinding): string {
  const parts: string[] = [];
  const m = binding.modifiers;
  if (m.cmdOrCtrl) parts.push(isMac ? 'Cmd' : 'Ctrl');
  if (m.ctrl && !m.cmdOrCtrl) parts.push('Ctrl');
  if (m.meta && !m.cmdOrCtrl) parts.push(isMac ? 'Cmd' : 'Super');
  if (m.alt) parts.push(isMac ? 'Opt' : 'Alt');
  if (m.shift) parts.push('Shift');

  let keyName = binding.key;
  if (keyName === 'ArrowLeft') keyName = '\u2190';
  if (keyName === 'ArrowRight') keyName = '\u2192';
  if (keyName === 'ArrowUp') keyName = '\u2191';
  if (keyName === 'ArrowDown') keyName = '\u2193';
  if (keyName === 'Backspace') keyName = '\u232B';
  if (keyName === 'Enter') keyName = '\u21B5';
  if (keyName === 'Escape') keyName = 'Esc';
  if (keyName.length === 1) keyName = keyName.toUpperCase();

  parts.push(keyName);
  return parts.join(' + ');
}

function escapeSequenceName(seq: string): string {
  if (seq === '\x1b[H') return 'Home';
  if (seq === '\x1b[F') return 'End';
  if (seq === '\x1b\r') return 'Alt+Enter';
  if (seq === '\x15') return 'Ctrl+U';
  if (seq === '\x1bb') return 'Word Left';
  if (seq === '\x1bf') return 'Word Right';
  return seq;
}

function isOverridden(bindingId: string): boolean {
  const presetOverrides = store.keybindingOverridesByPreset[store.keybindingPreset];
  return !!presetOverrides && Object.prototype.hasOwnProperty.call(presetOverrides, bindingId);
}

/** Section display order */
const CATEGORY_ORDER = ['Navigation', 'Tasks', 'App', 'Clipboard', 'Editing'];

function groupByCategory(bindings: KeyBinding[]): { category: string; bindings: KeyBinding[] }[] {
  const map = new Map<string, KeyBinding[]>();
  for (const b of bindings) {
    const list = map.get(b.category);
    if (list) {
      list.push(b);
    } else {
      map.set(b.category, [b]);
    }
  }
  const groups: { category: string; bindings: KeyBinding[] }[] = [];
  for (const cat of CATEGORY_ORDER) {
    const list = map.get(cat);
    if (list) groups.push({ category: cat, bindings: list });
  }
  // Include any categories not in the predefined order
  for (const [cat, list] of map) {
    if (!CATEGORY_ORDER.includes(cat)) {
      groups.push({ category: cat, bindings: list });
    }
  }
  return groups;
}

interface ConflictInfo {
  editingId: string;
  conflicting: KeyBinding;
  proposedKey: string;
  proposedModifiers: Modifiers;
}

export function HelpDialog(props: HelpDialogProps) {
  const [recordingId, setRecordingId] = createSignal<string | null>(null);
  const [conflictInfo, setConflictInfo] = createSignal<ConflictInfo | null>(null);

  // Clear recording state when dialog closes
  createEffect(() => {
    if (!props.open) {
      setRecordingId(null);
      setConflictInfo(null);
    }
  });

  // Global keydown listener for recording mode
  createEffect(() => {
    const rid = recordingId();
    if (!rid) return;

    const handler = (e: KeyboardEvent) => {
      // Ignore key repeat so holding a key doesn't spam rebinds
      if (e.repeat) return;

      e.preventDefault();
      e.stopPropagation();

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecordingId(null);
        setConflictInfo(null);
        return;
      }

      // Ignore bare modifier keys
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

      const modifiers: Modifiers = {};
      if (isMac) {
        if (e.metaKey && !e.ctrlKey) modifiers.cmdOrCtrl = true;
        if (e.ctrlKey && !e.metaKey) modifiers.ctrl = true;
        if (e.ctrlKey && e.metaKey) {
          modifiers.cmdOrCtrl = true;
          modifiers.ctrl = true;
        }
      } else {
        if (e.ctrlKey) modifiers.cmdOrCtrl = true;
        if (e.metaKey) modifiers.meta = true;
      }
      if (e.altKey) modifiers.alt = true;
      if (e.shiftKey) modifiers.shift = true;

      const proposed = { key: e.key, modifiers };
      const conflict = checkConflict(rid, proposed);

      if (conflict) {
        setConflictInfo({
          editingId: rid,
          conflicting: conflict,
          proposedKey: e.key,
          proposedModifiers: modifiers,
        });
      } else {
        setUserOverride(rid, proposed);
        setRecordingId(null);
        setConflictInfo(null);
      }
    };

    window.addEventListener('keydown', handler, true);
    onCleanup(() => window.removeEventListener('keydown', handler, true));
  });

  function handleOverride() {
    const info = conflictInfo();
    if (!info) return;
    // Revert the conflicting binding to its preset/default, then apply the proposed one
    clearUserOverride(info.conflicting.id);
    setUserOverride(info.editingId, {
      key: info.proposedKey,
      modifiers: info.proposedModifiers,
    });
    setRecordingId(null);
    setConflictInfo(null);
  }

  function handleSwap() {
    const info = conflictInfo();
    if (!info) return;
    // Find the current key+modifiers of the editing binding
    const editingBinding = allBindings().find((b) => b.id === info.editingId);
    if (!editingBinding) return;
    // Assign the proposed combo to the editing binding
    setUserOverride(info.editingId, {
      key: info.proposedKey,
      modifiers: info.proposedModifiers,
    });
    // Assign the editing binding's old combo to the conflicting binding
    setUserOverride(info.conflicting.id, {
      key: editingBinding.key,
      modifiers: editingBinding.modifiers,
    });
    setRecordingId(null);
    setConflictInfo(null);
  }

  function handleConflictCancel() {
    setRecordingId(null);
    setConflictInfo(null);
  }

  async function handleResetAll() {
    const confirmed = await appConfirm('Reset all keybindings to defaults for the current preset?');
    if (confirmed) {
      resetAllBindings();
    }
  }

  const hasOverrides = () => {
    const presetOverrides = store.keybindingOverridesByPreset[store.keybindingPreset];
    return !!presetOverrides && Object.keys(presetOverrides).length > 0;
  };
  const sections = () => groupByCategory(allBindings());

  function secondaryText(binding: KeyBinding): string | null {
    if (binding.escapeSequence) {
      return '\u2192 ' + escapeSequenceName(binding.escapeSequence);
    }
    if (binding.action === 'copy') return '\u2192 Copy';
    if (binding.action === 'paste') return '\u2192 Paste';
    return null;
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} width="540px" panelStyle={{ gap: '20px' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
        }}
      >
        <h2 style={{ margin: '0', 'font-size': '17px', color: theme.fg, 'font-weight': '600' }}>
          Keyboard Shortcuts
        </h2>
        <button
          onClick={() => props.onClose()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '19px',
            padding: '0 4px',
            'line-height': '1',
          }}
        >
          &times;
        </button>
      </div>

      {/* Preset selector row */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
        }}
      >
        <select
          value={store.keybindingPreset}
          onChange={(e) => selectPreset(e.currentTarget.value)}
          style={{
            background: theme.bgInput,
            color: theme.fg,
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            padding: '4px 8px',
            'font-size': '12px',
            cursor: 'pointer',
            outline: 'none',
            flex: '1',
          }}
        >
          <For each={[...PRESETS]}>
            {(preset) => (
              <option value={preset.id}>
                {preset.name}
                {preset.id === store.keybindingPreset && hasOverrides() ? ' (modified)' : ''}
              </option>
            )}
          </For>
        </select>
        <button
          onClick={handleResetAll}
          style={{
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            color: theme.fgMuted,
            'border-radius': '6px',
            padding: '4px 10px',
            'font-size': '11px',
            cursor: 'pointer',
            'white-space': 'nowrap',
          }}
        >
          Reset All
        </button>
      </div>

      {/* Binding sections */}
      <For each={sections()}>
        {(section) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
            <div
              style={{
                'font-size': '12px',
                color: theme.fgMuted,
                'text-transform': 'uppercase',
                'letter-spacing': '0.05em',
                'font-weight': '600',
              }}
            >
              {section.category}
            </div>
            <For each={section.bindings}>
              {(binding) => {
                const recording = () => recordingId() === binding.id;
                const overridden = () => isOverridden(binding.id);
                const conflict = () => {
                  const info = conflictInfo();
                  return info && info.editingId === binding.id ? info : null;
                };
                const secondary = secondaryText(binding);

                return (
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        'justify-content': 'space-between',
                        'align-items': 'center',
                        padding: '4px 0',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '1px',
                        }}
                      >
                        <span
                          style={{
                            color: theme.fgMuted,
                            'font-size': '12px',
                            ...(binding.unbound ? { opacity: '0.5' } : {}),
                          }}
                        >
                          {binding.description}
                        </span>
                        <Show when={secondary}>
                          <span style={{ color: theme.fgSubtle, 'font-size': '10px' }}>
                            {secondary}
                          </span>
                        </Show>
                      </div>
                      <div style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
                        <Show when={overridden()}>
                          <button
                            onClick={() => clearUserOverride(binding.id)}
                            title="Reset to default"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: theme.fgMuted,
                              cursor: 'pointer',
                              'font-size': '13px',
                              padding: '0 2px',
                              'line-height': '1',
                            }}
                          >
                            {'\u21BA'}
                          </button>
                        </Show>
                        <kbd
                          role="button"
                          tabIndex={0}
                          aria-label={
                            binding.unbound
                              ? `${binding.description}: unbound, click to assign`
                              : `${binding.description}: ${formatKeyCombo(binding)}, click to rebind`
                          }
                          onClick={() => {
                            if (recording()) {
                              setRecordingId(null);
                              setConflictInfo(null);
                            } else {
                              setConflictInfo(null);
                              setRecordingId(binding.id);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              if (recording()) {
                                setRecordingId(null);
                                setConflictInfo(null);
                              } else {
                                setConflictInfo(null);
                                // Defer activation so the Enter/Space keyup
                                // has time to fire before the recording
                                // listener attaches.
                                setTimeout(() => setRecordingId(binding.id), 0);
                              }
                            }
                          }}
                          style={{
                            background: recording() ? theme.accent : theme.bgInput,
                            border: `1px solid ${recording() ? theme.accent : overridden() ? theme.accent : theme.border}`,
                            'border-radius': '4px',
                            padding: '2px 8px',
                            'font-size': '11px',
                            color: recording()
                              ? theme.accentText
                              : binding.unbound
                                ? theme.fgMuted
                                : overridden()
                                  ? theme.accent
                                  : theme.fg,
                            'font-family': "'JetBrains Mono', monospace",
                            'white-space': 'nowrap',
                            cursor: 'pointer',
                            'user-select': 'none',
                            ...(recording()
                              ? { animation: 'keybind-pulse 1s ease-in-out infinite' }
                              : {}),
                          }}
                        >
                          {recording()
                            ? 'Press shortcut...'
                            : binding.unbound
                              ? '\u2014'
                              : formatKeyCombo(binding)}
                        </kbd>
                      </div>
                    </div>

                    {/* Conflict warning */}
                    <Show when={conflict()}>
                      {(info) => (
                        <div
                          style={{
                            background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
                            border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
                            'border-radius': '6px',
                            padding: '6px 10px',
                            'margin-top': '4px',
                            'margin-bottom': '4px',
                            'font-size': '11px',
                            color: theme.warning,
                            display: 'flex',
                            'flex-direction': 'column',
                            gap: '6px',
                          }}
                        >
                          <span>
                            Already used by &ldquo;{info().conflicting.description}&rdquo; (
                            {info().conflicting.layer})
                          </span>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              onClick={handleOverride}
                              style={{
                                background: theme.bgInput,
                                border: `1px solid ${theme.border}`,
                                color: theme.fg,
                                'border-radius': '4px',
                                padding: '2px 8px',
                                'font-size': '11px',
                                cursor: 'pointer',
                              }}
                            >
                              Override
                            </button>
                            <button
                              onClick={handleSwap}
                              style={{
                                background: theme.bgInput,
                                border: `1px solid ${theme.border}`,
                                color: theme.fg,
                                'border-radius': '4px',
                                padding: '2px 8px',
                                'font-size': '11px',
                                cursor: 'pointer',
                              }}
                            >
                              Swap
                            </button>
                            <button
                              onClick={handleConflictCancel}
                              style={{
                                background: 'transparent',
                                border: `1px solid ${theme.border}`,
                                color: theme.fgMuted,
                                'border-radius': '4px',
                                padding: '2px 8px',
                                'font-size': '11px',
                                cursor: 'pointer',
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </For>

      {/* Pulse animation for recording mode */}
      <style>{`
        @keyframes keybind-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </Dialog>
  );
}
