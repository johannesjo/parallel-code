import { For, Show, type JSX } from 'solid-js';
import {
  ASK_CODE_CLAUDE_MODELS,
  ASK_CODE_MODELS,
  askCodeEfforts,
} from '../../electron/shared/ask-code-models';
import type { CheckModelSettings } from '../../electron/shared/checks';
import { effortToRun, modelToRun } from '../lib/ask-code-model';
import { theme } from '../lib/theme';

type ModelChoice = Pick<CheckModelSettings, 'provider' | 'model' | 'effort'>;

// Same height and corners as the dialog's text inputs, so a check row lines up with them.
export const fieldStyle: JSX.CSSProperties = {
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-md)',
  padding: '7px 10px',
  color: theme.fg,
  'font-size': '13px',
  'min-width': '0',
};

/** Provider, model and reasoning level for a one-shot review call. */
export function ReviewModelFields(props: {
  value: ModelChoice;
  onChange: (change: Partial<ModelChoice>) => void;
  /** Matches the fields around them; defaults to the dialog field look. */
  style?: JSX.CSSProperties;
}) {
  const style = () => props.style ?? fieldStyle;
  return (
    <>
      <select
        aria-label="Review provider"
        value={props.value.provider}
        onChange={(e) =>
          props.onChange({
            provider: e.currentTarget.value === 'codex' ? 'codex' : 'claude',
            model: undefined,
            effort: undefined,
          })
        }
        style={style()}
      >
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <Show
        when={props.value.provider === 'claude'}
        fallback={
          <input
            aria-label="Review model"
            // An empty field runs this model; the request names it.
            placeholder={modelToRun('codex', '') || 'Model slug'}
            value={props.value.model ?? ''}
            onInput={(e) => props.onChange({ model: e.currentTarget.value.trim() || undefined })}
            style={style()}
          />
        }
      >
        <select
          aria-label="Review model"
          // Unset runs the same model the request falls back to.
          value={props.value.model ?? ASK_CODE_MODELS.claude}
          onChange={(e) => props.onChange({ model: e.currentTarget.value || undefined })}
          style={style()}
        >
          <For each={ASK_CODE_CLAUDE_MODELS}>{(m) => <option value={m}>{m}</option>}</For>
        </select>
      </Show>
      <select
        aria-label="Reasoning level"
        value={effortToRun(
          props.value.provider,
          props.value.model || modelToRun(props.value.provider, ''),
          props.value.effort ?? '',
        )}
        onChange={(e) => props.onChange({ effort: e.currentTarget.value || undefined })}
        style={style()}
      >
        <For each={askCodeEfforts(props.value.provider)}>
          {(effort) => <option value={effort}>{effort}</option>}
        </For>
      </select>
    </>
  );
}
