import { IPC } from '../../electron/ipc/channels';
import { askCodeEnvFile } from '../../electron/shared/ask-code-models';
import {
  EVIDENCE_MODEL_TIMEOUT_MS,
  type EvidenceModelSettings,
} from '../../electron/shared/evidence';
import { Channel, invoke } from './ipc';
import { warn as logWarn } from './log';

interface AskMessage {
  type: 'chunk' | 'error' | 'done';
  text?: string;
  exitCode?: number;
}

/** A review is a short summary and a handful of findings. */
const MAX_RESPONSE_CHARS = 60_000;
const MAX_ERROR_CHARS = 4_000;

export interface EvidenceModelRequest {
  result: Promise<string>;
  cancel: () => void;
}

/**
 * One structured call with the project's provider, model and reasoning level:
 * an evidence review, or (`purpose: 'checks'`) a suggested check setup.
 * Resolves with the response text; rejects on provider failure, a runaway
 * response, or the client deadline.
 */
export function startEvidenceModelRequest(options: {
  prompt: string;
  cwd: string;
  settings: EvidenceModelSettings;
  agentEnvFiles: Record<string, string>;
  purpose?: 'evidence' | 'checks';
}): EvidenceModelRequest {
  const requestId = crypto.randomUUID();
  const channel = new Channel<AskMessage>();
  let active = true;
  let response = '';
  let providerError = '';
  let settle: { resolve: (text: string) => void; reject: (error: Error) => void };
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Let the backend's own timeout report first, and cover lost IPC events.
  const deadline = setTimeout(
    () => stop(new Error('The model did not finish in time.')),
    EVIDENCE_MODEL_TIMEOUT_MS + 5000,
  );

  function end(): boolean {
    if (!active) return false;
    active = false;
    clearTimeout(deadline);
    channel.dispose();
    return true;
  }
  function stop(error: Error): void {
    if (!end()) return;
    settle.reject(error);
    void invoke(IPC.CancelAskAboutCode, { requestId }).catch((cancelError: unknown) =>
      logWarn('evidence', 'Could not cancel the model request', { error: cancelError }),
    );
  }

  channel.onmessage = (message) => {
    if (!active) return;
    if (message.type === 'chunk') {
      response += message.text ?? '';
      if (response.length > MAX_RESPONSE_CHARS) stop(new Error('The response was too long.'));
    } else if (message.type === 'error') {
      providerError = (providerError + (message.text ?? '')).slice(0, MAX_ERROR_CHARS);
    } else if (message.type === 'done' && end()) {
      if (message.exitCode === 0) settle.resolve(response);
      else settle.reject(new Error(providerError || 'The model provider failed.'));
    }
  };

  const { provider, model, effort } = options.settings;
  void invoke(IPC.AskAboutCode, {
    requestId,
    purpose: options.purpose ?? 'evidence',
    prompt: options.prompt,
    cwd: options.cwd,
    onOutput: channel,
    provider,
    model,
    effort,
    envFile: askCodeEnvFile(provider, options.agentEnvFiles),
  }).catch((error: unknown) => {
    if (end()) settle.reject(error instanceof Error ? error : new Error(String(error)));
  });

  return { result, cancel: () => stop(new Error('Cancelled.')) };
}
