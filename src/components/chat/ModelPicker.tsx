import { For, Show, createEffect, createSignal } from 'solid-js';
import { ShieldIcon } from '../icons';
import {
  reasoningEffortLabel,
  selectedChatModel,
  effectiveReasoningEffort,
} from '../../../electron/shared/chat-messages';
import {
  type AgentChatState,
  type ChatPermissionMode,
  CHAT_PERMISSION_MODES,
  isChatPermissionMode,
} from '../../../electron/shared/agent-chat-types';

/**
 * Keeps a select showing `value`, re-applied whenever its options change: a value
 * set before its option exists (a model list arriving late) would not stick.
 * `options` must read the values the options show: a list reconciled in place
 * keeps its array, so only its contents signal the change.
 */
function syncValue(value: () => string, options: () => unknown = () => undefined) {
  return (select: HTMLSelectElement) =>
    createEffect(() => {
      options();
      select.value = value();
    });
}

const PERMISSION_LABELS: Record<ChatPermissionMode, string> = {
  default: 'Ask each time',
  auto: 'Auto',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
};

/** Model and reasoning level for the next message, on the composer's bottom edge. */
export function ModelPicker(props: {
  state: AgentChatState;
  disabled: boolean;
  onSelectModel: (model: string, reasoningEffort?: string) => Promise<void>;
  onReloadModels: () => Promise<void>;
}) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const models = () => props.state.models ?? [];
  const selected = () => selectedChatModel(props.state);
  const efforts = () => selected()?.supportedReasoningEfforts ?? [];
  const unavailable = () => props.disabled || pending() || props.state.status !== 'ready';
  /** On failure the select snaps back to what the agent still uses. */
  async function change(action: () => Promise<void>, select?: HTMLSelectElement, current = '') {
    setPending(true);
    setError('');
    try {
      await action();
    } catch (error) {
      if (select) select.value = current;
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  const effort = () => effectiveReasoningEffort(props.state);
  const unlistedEffort = () =>
    props.state.reasoningEffort &&
    !efforts().some((option) => option.reasoningEffort === props.state.reasoningEffort);
  return (
    <div class="chat-model-settings">
      {/* No visible captions: the selects sit on the composer and name themselves
          through their own values, so `aria-label` carries the accessible name. */}
      <div class="chat-model-selectors">
        <select
          aria-label="Model"
          title="Model for the next message"
          ref={syncValue(
            () => props.state.model ?? '',
            () => models().map((model) => model.model),
          )}
          disabled={unavailable() || !models().length}
          onChange={(event) => {
            const select = event.currentTarget;
            // eslint-disable-next-line solid/reactivity -- called at once, inside this handler
            void change(() => props.onSelectModel(select.value), select, props.state.model);
          }}
        >
          <Show when={!selected()}>
            <option value={props.state.model ?? ''} disabled>
              {props.state.model}
            </option>
          </Show>
          <For each={models()}>
            {(model) => <option value={model.model}>{model.displayName}</option>}
          </For>
        </select>
        <Show when={efforts().length}>
          <select
            aria-label="Reasoning effort"
            title="Reasoning level for the next message"
            ref={syncValue(
              () => effort() ?? '',
              () => [
                selected()?.defaultReasoningEffort,
                ...efforts().map((option) => option.reasoningEffort),
              ],
            )}
            disabled={unavailable() || !efforts().length}
            onChange={(event) => {
              const select = event.currentTarget;
              void change(
                // eslint-disable-next-line solid/reactivity -- called at once, inside this handler
                () => props.onSelectModel(selected()?.model ?? '', select.value),
                select,
                effort(),
              );
            }}
          >
            {/* Only when the agent has not said which effort it will use; naming none beats a guess. */}
            <Show when={!effort()}>
              <option value="" />
            </Show>
            <Show when={unlistedEffort()}>
              <option value={props.state.reasoningEffort} disabled>
                {props.state.reasoningEffort}
              </option>
            </Show>
            <For each={efforts()}>
              {(option) => (
                <option value={option.reasoningEffort} title={option.description}>
                  {reasoningEffortLabel(option.reasoningEffort)}
                </option>
              )}
            </For>
          </select>
        </Show>
      </div>
      <Show when={error() || props.state.modelsError}>
        <div class="chat-model-error" role="alert">
          {error() || `Models unavailable: ${props.state.modelsError}`}
          <Show when={props.state.modelsError}>
            <button disabled={pending()} onClick={() => void change(props.onReloadModels)}>
              Retry
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** Claude's permission mode, switchable while the session runs. */
export function PermissionPicker(props: {
  mode?: string;
  disabled: boolean;
  onChange: (mode: ChatPermissionMode) => Promise<void>;
  onError: (error: string) => void;
}) {
  const [pending, setPending] = createSignal(false);
  return (
    // The icon sits in the select's own padding and lets clicks through to it.
    <span class="chat-picker">
      <ShieldIcon size={11} class="chat-picker-icon" />
      <select
        aria-label="Permission mode"
        ref={syncValue(() => props.mode ?? '')}
        disabled={props.disabled || pending()}
        onChange={(event) => {
          const select = event.currentTarget;
          const mode = select.value;
          if (!isChatPermissionMode(mode)) return;
          setPending(true);
          void props
            .onChange(mode)
            // eslint-disable-next-line solid/reactivity -- restores whatever mode is current when the change fails
            .catch((error: unknown) => {
              select.value = props.mode ?? '';
              props.onError(String(error));
            })
            .finally(() => setPending(false));
        }}
      >
        <Show when={!isChatPermissionMode(props.mode)}>
          <option value={props.mode ?? ''}>
            {props.mode === 'bypassPermissions'
              ? 'Skipping permissions'
              : props.mode || 'Permissions'}
          </option>
        </Show>
        <For each={CHAT_PERMISSION_MODES}>
          {(mode) => <option value={mode}>{PERMISSION_LABELS[mode]}</option>}
        </For>
      </select>
    </span>
  );
}
