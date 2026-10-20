/**
 * Runs one streamed `purpose: 'understand'` request and resolves with the whole
 * response text. Generation and follow-up questions share this, so caps,
 * cancellation and the timing log live in one place.
 * See docs/guided-understanding-plan.md.
 */

import { IPC } from '../../electron/ipc/channels';
import { askCodeEnvFile } from '../../electron/shared/ask-code-models';
import {
  UNDERSTANDING_MAX_OUTPUT_CHARS,
  UNDERSTANDING_TIMEOUT_MS,
} from '../../electron/shared/understanding-limits';
import { store } from '../store/store';
import { Channel, invoke } from './ipc';
import { errMessage, info as logInfo, warn as logWarn } from './log';
import { PROVIDER_ERROR_CHARS, providerFailureMessage } from './provider-error';

interface TourMessage {
  type: 'chunk' | 'error' | 'done';
  text?: string;
  exitCode?: number;
}

/**
 * A tour is a handful of small cards; anything larger is a runaway response.
 * Never below the largest tour the validator accepts, with room for the fences
 * and commentary the JSON reader strips.
 */
const MAX_RESPONSE_CHARS = Math.max(60_000, UNDERSTANDING_MAX_OUTPUT_CHARS + 8_000);
/** Let the backend's own timeout report first, and cover lost IPC events. */
const CLIENT_DEADLINE_MS = UNDERSTANDING_TIMEOUT_MS + 5000;

export type UnderstandingRequestResult =
  | { status: 'done'; text: string }
  | { status: 'failed'; message: string }
  | { status: 'cancelled' };

/** Which request this was; the timing log keeps them apart. */
export type UnderstandingRequestKind = 'tour' | 'follow-up';

export interface UnderstandingRequestHandle {
  result: Promise<UnderstandingRequestResult>;
  cancel: () => void;
}

export function startUnderstandingRequest(options: {
  prompt: string;
  cwd: string;
  request: UnderstandingRequestKind;
  onElapsed: (seconds: number) => void;
  onReceiving: () => void;
  /** Provider stderr arrives before `done`, so it can be shown while waiting. */
  onProviderError: (message: string) => void;
}): UnderstandingRequestHandle {
  const requestId = crypto.randomUUID();
  const channel = new Channel<TourMessage>();
  const provider = store.askCodeProvider;
  // Empty means "let the CLI choose"; the handler only accepts a real model or none.
  const model = store.askCodeModel || undefined;
  const envFile = askCodeEnvFile(provider, store.agentEnvFiles);
  const startedAt = Date.now();
  let active = true;
  let response = '';
  let providerError = '';
  let firstOutputMs: number | null = null;
  let settle: (result: UnderstandingRequestResult) => void = () => {};
  const result = new Promise<UnderstandingRequestResult>((resolve) => {
    settle = resolve;
  });
  const ticker = setInterval(
    () => options.onElapsed(Math.floor((Date.now() - startedAt) / 1000)),
    1000,
  );

  const deadline = setTimeout(
    () =>
      fail(
        'timeout',
        'The tour did not finish within five minutes. Check the code Q&A provider in Settings, then try again.',
      ),
    CLIENT_DEADLINE_MS,
  );

  /** Ends the request exactly once; later channel messages are ignored. */
  function finish(outcome: string, value: UnderstandingRequestResult): void {
    if (!active) return;
    active = false;
    clearInterval(ticker);
    clearTimeout(deadline);
    channel.dispose();
    // Sizes and durations only — card text never reaches the log.
    logInfo('understandingTour', 'Tour request finished', {
      requestId,
      provider,
      request: options.request,
      promptChars: options.prompt.length,
      responseChars: response.length,
      firstOutputMs,
      durationMs: Date.now() - startedAt,
      outcome,
    });
    settle(value);
  }

  function abortBackend(): void {
    void invoke(IPC.CancelAskAboutCode, { requestId }).catch((error) =>
      logWarn('understandingTour', 'Could not cancel request', { error: errMessage(error) }),
    );
  }

  function fail(outcome: string, message: string): void {
    if (!active) return;
    finish(outcome, { status: 'failed', message });
    abortBackend();
  }

  channel.onmessage = (message) => {
    if (!active) return;
    if (message.type === 'chunk') {
      if (message.text) {
        firstOutputMs ??= Date.now() - startedAt;
        options.onReceiving();
        response += message.text;
      }
      if (response.length > MAX_RESPONSE_CHARS)
        fail('response-too-long', 'The tour response was too long. Try again.');
      return;
    }
    if (message.type === 'error') {
      providerError = (providerError + (message.text ?? '')).slice(0, PROVIDER_ERROR_CHARS);
      options.onProviderError(providerError);
      return;
    }
    if (message.exitCode !== 0)
      finish('failed', {
        status: 'failed',
        message: providerFailureMessage(
          providerError,
          response,
          'The tour provider failed. Try again.',
        ),
      });
    else finish('completed', { status: 'done', text: response });
  };

  void invoke(IPC.AskAboutCode, {
    requestId,
    purpose: 'understand',
    prompt: options.prompt,
    cwd: options.cwd,
    onOutput: channel,
    provider,
    model,
    envFile,
  }).catch((error) => {
    if (!active) return;
    finish('failed', { status: 'failed', message: errMessage(error) });
  });

  return {
    result,
    cancel: () => {
      if (!active) return;
      finish('cancelled', { status: 'cancelled' });
      abortBackend();
    },
  };
}
