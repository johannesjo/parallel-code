import { createSignal, onCleanup, Show } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type { CheckSource, CheckModelSettings } from '../../electron/shared/checks';
import {
  buildCheckSuggestionPrompt,
  parseCheckSuggestion,
  type CheckSuggestion,
} from '../lib/check-suggestion';
import { startModelRequest, type ModelRequest } from '../lib/model-request';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { theme } from '../lib/theme';
import { store } from '../store/core';
import { projectIdForPath } from '../store/project-path';
import { SparkleIcon } from './icons';

interface SuggestChecksButtonProps {
  projectRoot: string;
  /** The reviewer model, which also suggests checks. */
  model: CheckModelSettings;
  onSuggest: (suggestion: CheckSuggestion) => void;
  /** Defaults to "Suggest with AI". */
  label?: string;
  /** What to do with the suggestion; defaults to reviewing it before Save. */
  doneHint?: string;
  /** A larger button, for when it leads a whole section. */
  large?: boolean;
}

/**
 * Asks the review model to fill the verify command and project checks from
 * the project's manifests. Only fills the form; nothing is saved until Save.
 */
export function SuggestChecksButton(props: SuggestChecksButtonProps) {
  const [running, setRunning] = createSignal(false);
  const [status, setStatus] = createSignal<{ text: string; error?: boolean }>();
  let request: ModelRequest | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    request?.cancel();
  });

  async function suggest(): Promise<void> {
    setRunning(true);
    setStatus(undefined);
    try {
      const sources = await invoke<CheckSource[]>(IPC.ReadCheckSources, {
        projectRoot: props.projectRoot,
      });
      // A closed dialog must not start a paid model call nobody can cancel.
      if (disposed) return;
      if (sources.length === 0) throw new Error('No build or test files found in the project.');
      request = startModelRequest({
        prompt: buildCheckSuggestionPrompt(sources),
        cwd: props.projectRoot,
        settings: props.model,
        agentEnvFiles: store.agentEnvFiles,
        projectId: projectIdForPath(props.projectRoot),
        purpose: 'checks',
      });
      const suggestion = parseCheckSuggestion(await request.result);
      if (disposed) return;
      if (!suggestion.verifyCommand && suggestion.checks.length === 0)
        throw new Error(suggestion.reason ?? 'The model found no commands to suggest.');
      props.onSuggest(suggestion);
      // A saved verify command can run in the background and checks run in the task
      // worktree, so always ask for a review.
      const review = props.doneHint ?? 'Review the commands before saving.';
      setStatus({ text: suggestion.reason ? `${suggestion.reason} ${review}` : review });
    } catch (err) {
      if (!disposed) setStatus({ text: errMessage(err), error: true });
    } finally {
      request = undefined;
      if (!disposed) setRunning(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '4px', 'justify-items': 'start' }}>
      <button
        class="btn-with-icon"
        type="button"
        disabled={running()}
        onClick={() => void suggest()}
        title="Reads package.json, Makefile, CI workflows and similar files and asks the review model for commands"
        style={{
          padding: props.large ? '6px 14px' : '3px 10px',
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-sm)',
          color: theme.fgMuted,
          cursor: running() ? 'default' : 'pointer',
          'font-size': props.large ? '13px' : '12px',
        }}
      >
        <SparkleIcon size={props.large ? 14 : 12} />
        {running() ? 'Suggesting…' : (props.label ?? 'Suggest with AI')}
      </button>
      <Show when={status()}>
        {(current) => (
          <div
            role={current().error ? 'alert' : 'status'}
            style={{
              'font-size': '12px',
              color: current().error ? theme.error : theme.fgSubtle,
              padding: '2px 2px 0',
            }}
          >
            {current().text}
          </div>
        )}
      </Show>
    </div>
  );
}
