import { createSignal, createEffect, Show, For, createUniqueId, on, createMemo } from 'solid-js';
import { Dialog } from './Dialog';
import { errMessage } from '../lib/log';
import { theme, sectionLabelStyle } from '../lib/theme';
import {
  generateThemePrompt,
  parseThemeCss,
  checkThemeContrast,
  themeToCss,
  detectThemeTone,
} from '../lib/custom-theme';
import type { CustomTheme, ContrastWarning } from '../lib/custom-theme';
import {
  store,
  saveCustomTheme,
  deleteCustomTheme,
  setDarkTheme,
  setLightTheme,
} from '../store/store';
import { osIsDark } from '../lib/os-appearance';

interface CustomThemeDialogProps {
  open: boolean;
  /** When set, we're editing an existing custom theme */
  editId?: string | null;
  /** Pre-filled CSS (e.g. from a cloned built-in preset) */
  initialCss?: string;
  onClose: () => void;
}

function buildCssForEdit(t: CustomTheme): string {
  return themeToCss(t.name, t.description, t.terminalBackground, t.vars);
}

export function CustomThemeDialog(props: CustomThemeDialogProps) {
  const titleId = createUniqueId();
  const [css, setCss] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [warnings, setWarnings] = createSignal<ContrastWarning[]>([]);
  const [copied, setCopied] = createSignal(false);
  const [showPrompt, setShowPrompt] = createSignal(false);

  // Label for the save button: "Save & Apply" only when the detected tone
  // matches the currently-active slot; otherwise "Save to {tone} slot".
  const saveLabel = createMemo(() => {
    if (props.editId) return 'Update Theme';
    const result = parsed();
    if (!result) return 'Save & Apply';
    const tone = detectThemeTone(result.vars);
    const currentSlot =
      store.appearanceMode === 'system' ? (osIsDark() ? 'dark' : 'light') : store.appearanceMode;
    return tone === currentSlot ? 'Save & Apply' : `Save to ${tone} slot`;
  });

  // Reset state when dialog opens/closes or switches edit target
  createEffect(
    on(
      () => [props.open, props.editId, props.initialCss] as const,
      ([open, editId, initialCss]) => {
        if (!open) return;
        setError(null);
        setSaveError(null);
        setCopied(false);
        setShowPrompt(false);
        if (editId && store.customThemes[editId]) {
          setCss(buildCssForEdit(store.customThemes[editId]));
        } else if (initialCss) {
          setCss(initialCss);
        } else {
          setCss('');
        }
      },
    ),
  );

  // Live validation + contrast check
  createEffect(() => {
    const text = css().trim();
    if (!text) {
      setError(null);
      setWarnings([]);
      return;
    }
    try {
      const parsed = parseThemeCss(text);
      setError(null);
      setWarnings(checkThemeContrast(parsed.vars));
    } catch (e) {
      setError(errMessage(e));
      setWarnings([]);
    }
  });

  function parsed() {
    try {
      return parseThemeCss(css().trim());
    } catch {
      return null;
    }
  }

  async function handleSave() {
    const result = parsed();
    if (!result) return;
    const id = props.editId ?? crypto.randomUUID();
    const newTheme: CustomTheme = { id, ...result };
    setSaveError(null);
    try {
      await saveCustomTheme(newTheme);
    } catch (e) {
      setSaveError(`Failed to save theme: ${errMessage(e)}`);
      return;
    }
    const newTone = detectThemeTone(result.vars);
    if (!props.editId) {
      // On create: assign to the slot matching the theme's detected tone.
      if (newTone === 'light') {
        setLightTheme(store.lightThemePreset, id);
      } else {
        setDarkTheme(store.darkThemePreset, id);
      }
    } else {
      // On edit: if the theme is referenced by a slot and its tone changed,
      // move the slot reference so the card stays visible in the correct grid.
      const inDark = store.darkThemeCustomId === id;
      const inLight = store.lightThemeCustomId === id;
      if (inDark && newTone === 'light') {
        setDarkTheme(store.darkThemePreset, null);
        setLightTheme(store.lightThemePreset, id);
      } else if (inLight && newTone === 'dark') {
        setLightTheme(store.lightThemePreset, null);
        setDarkTheme(store.darkThemePreset, id);
      }
    }
    props.onClose();
  }

  function handleCopyPrompt() {
    const currentCss = css().trim();
    const prompt = generateThemePrompt(currentCss || undefined);
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const isValid = () => css().trim().length > 0 && parsed() !== null;

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="560px"
      zIndex={1200}
      labelledBy={titleId}
      panelStyle={{ 'max-width': 'calc(100vw - 32px)', padding: '24px', gap: '16px' }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
        <h2
          id={titleId}
          style={{ margin: '0', 'font-size': '17px', color: theme.fg, 'font-weight': '600' }}
        >
          {props.editId ? 'Edit Theme' : 'New Custom Theme'}
        </h2>
        <button
          onClick={() => props.onClose()}
          aria-label="Close"
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

      {/* AI Prompt section */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
        <div
          style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}
        >
          <span style={sectionLabelStyle}>AI Prompt</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={() => setShowPrompt((v) => !v)}
              style={{
                background: 'transparent',
                border: `1px solid ${theme.border}`,
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': '12px',
                padding: '3px 10px',
                'border-radius': 'var(--radius-xs)',
              }}
            >
              {showPrompt() ? 'Hide' : 'Show'} prompt
            </button>
            <button
              type="button"
              onClick={handleCopyPrompt}
              style={{
                background: copied() ? theme.success : theme.bgInput,
                border: `1px solid ${copied() ? theme.success : theme.border}`,
                color: copied() ? theme.accentText : theme.fg,
                cursor: 'pointer',
                'font-size': '12px',
                padding: '3px 10px',
                'border-radius': 'var(--radius-xs)',
                transition: 'background 0.2s, border-color 0.2s',
              }}
            >
              {copied() ? 'Copied!' : 'Copy Prompt'}
            </button>
          </div>
        </div>
        <Show when={showPrompt()}>
          <textarea
            readonly
            value={generateThemePrompt()}
            style={{
              width: '100%',
              height: '120px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              color: theme.fgMuted,
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '11px',
              padding: '8px',
              'border-radius': 'var(--radius-sm)',
              resize: 'vertical',
              'box-sizing': 'border-box',
            }}
          />
        </Show>
        <p
          style={{ margin: '0', 'font-size': '12px', color: theme.fgSubtle, 'line-height': '1.5' }}
        >
          Copy the prompt above and paste it into Claude Code (or any AI). The AI will ask about
          your preferences and generate a CSS theme. Paste the result below.
        </p>
      </div>

      {/* CSS paste area */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <span style={sectionLabelStyle}>Theme CSS</span>
        <textarea
          value={css()}
          onInput={(e) => setCss(e.currentTarget.value)}
          placeholder={
            '/*\n  name: My Theme\n  terminalBackground: #1a1a2e\n*/\n\n:root {\n  --bg: #0f0e17;\n  --fg: #fffffe;\n}'
          }
          spellcheck={false}
          style={{
            width: '100%',
            height: '200px',
            background: theme.bgInput,
            border: `1px solid ${error() ? theme.error : warnings().length > 0 ? theme.warning : isValid() ? theme.success : theme.border}`,
            color: theme.fg,
            'font-family': "'JetBrains Mono', monospace",
            'font-size': '12px',
            padding: '10px',
            'border-radius': 'var(--radius-sm)',
            resize: 'vertical',
            'box-sizing': 'border-box',
            outline: 'none',
            transition: 'border-color 0.15s',
          }}
        />
        <Show when={error()}>
          <p style={{ margin: '0', 'font-size': '12px', color: theme.error, 'line-height': '1.5' }}>
            {error()}
          </p>
        </Show>
        <Show when={parsed()} keyed>
          {(p) => (
            <p
              style={{
                margin: '0',
                'font-size': '12px',
                color: warnings().length > 0 ? theme.warning : theme.success,
              }}
            >
              Theme is valid — {Object.keys(p.vars).length} variable(s) defined.
              {warnings().length > 0 ? ` ${warnings().length} contrast warning(s).` : ''}
            </p>
          )}
        </Show>
        <Show when={warnings().length > 0}>
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '4px',
              padding: '8px 10px',
              background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
              border: `1px solid color-mix(in srgb, ${theme.warning} 25%, transparent)`,
              'border-radius': 'var(--radius-sm)',
            }}
          >
            <span style={{ 'font-size': '11px', 'font-weight': '600', color: theme.warning }}>
              Contrast warnings (theme will still save)
            </span>
            <For each={warnings()}>
              {(w) => (
                <span
                  style={{
                    'font-size': '11px',
                    color: theme.fgMuted,
                    'font-family': "'JetBrains Mono', monospace",
                  }}
                >
                  {w.fgVar} on {w.bgVar}: {w.ratio.toFixed(2)}:1 (need {w.required}:1)
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={saveError()}>
        <p style={{ margin: '0', 'font-size': '12px', color: theme.error, 'line-height': '1.5' }}>
          {saveError()}
        </p>
      </Show>

      {/* Actions */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'margin-top': '4px',
        }}
      >
        <Show when={props.editId}>
          {(editId) => (
            <button
              type="button"
              onClick={async () => {
                try {
                  await deleteCustomTheme(editId());
                  props.onClose();
                } catch (e) {
                  setSaveError(`Failed to delete theme: ${errMessage(e)}`);
                }
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.error,
                cursor: 'pointer',
                'font-size': '13px',
                padding: '7px 0',
              }}
            >
              Delete Theme
            </button>
          )}
        </Show>
        <div style={{ display: 'flex', gap: '8px', 'margin-left': 'auto' }}>
          <button
            type="button"
            onClick={() => props.onClose()}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              color: theme.fgMuted,
              cursor: 'pointer',
              'font-size': '14px',
              padding: '7px 18px',
              'border-radius': 'var(--radius-sm)',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isValid()}
            style={{
              background: isValid() ? theme.accent : theme.bgInput,
              border: `1px solid ${isValid() ? theme.accent : theme.border}`,
              color: isValid() ? theme.accentText : theme.fgSubtle,
              cursor: isValid() ? 'pointer' : 'not-allowed',
              'font-size': '14px',
              'font-weight': '600',
              padding: '7px 18px',
              'border-radius': 'var(--radius-sm)',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            {saveLabel()}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
