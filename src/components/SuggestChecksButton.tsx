import { createSignal, onCleanup, Show } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type { CheckSource, EvidenceModelSettings } from '../../electron/shared/evidence';
import {
  buildCheckSuggestionPrompt,
  parseCheckSuggestion,
  type CheckSuggestion,
} from '../lib/check-suggestion';
import {
  startEvidenceModelRequest,
  type EvidenceModelRequest,
} from '../lib/evidence-model-request';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { theme } from '../lib/theme';
import { store } from '../store/core';

interface SuggestChecksButtonProps {
  projectRoot: string;
  /** The review model the dialog currently shows, saved or not. */
  model: EvidenceModelSettings;
  onSuggest: (suggestion: CheckSuggestion) => void;
}

/**
 * Asks the review model to fill the verify command and evidence checks from
 * the project's manifests. Only fills the form; nothing is saved until Save.
 */
export function SuggestChecksButton(props: SuggestChecksButtonProps) {
  const [running, setRunning] = createSignal(false);
  const [status, setStatus] = createSignal<{ text: string; error?: boolean }>();
  let request: EvidenceModelRequest | undefined;
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
      request = startEvidenceModelRequest({
        prompt: buildCheckSuggestionPrompt(sources),
        cwd: props.projectRoot,
        settings: props.model,
        agentEnvFiles: store.agentEnvFiles,
        purpose: 'checks',
      });
      const suggestion = parseCheckSuggestion(await request.result);
      if (disposed) return;
      if (!suggestion.verifyCommand && suggestion.checks.length === 0)
        throw new Error(suggestion.reason ?? 'The model found no commands to suggest.');
      props.onSuggest(suggestion);
      // Suggested commands run automatically once saved, so always ask for a review.
      const review = 'Review the commands before saving.';
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
        type="button"
        disabled={running()}
        onClick={() => void suggest()}
        title="Reads package.json, Makefile, CI workflows and similar files and asks the evidence review model for commands"
        style={{
          padding: '3px 10px',
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-sm)',
          color: theme.fgMuted,
          cursor: running() ? 'default' : 'pointer',
          'font-size': '12px',
        }}
      >
        {running() ? 'Suggesting…' : 'Suggest with AI'}
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
