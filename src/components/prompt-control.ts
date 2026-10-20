export function shouldHandoffCoordinatorQuestion(params: {
  controlledBy: 'coordinator' | 'human' | undefined;
  questionActive: boolean;
  agentIdle: boolean;
  startupBlocking: boolean;
  autoTrustSettling: boolean;
  autoTrustHandled: boolean;
  recentPromptEcho: boolean;
}): boolean {
  return (
    params.controlledBy === 'coordinator' &&
    params.questionActive &&
    params.agentIdle &&
    !params.startupBlocking &&
    !params.autoTrustSettling &&
    !params.autoTrustHandled &&
    !params.recentPromptEcho
  );
}

export function shouldAckInitialPromptDelivery(params: {
  coordinatedBy: string | undefined;
  initialPrompt: string | undefined;
  sentText: string;
}): boolean {
  const initialPrompt = params.initialPrompt?.trim();
  return Boolean(params.coordinatedBy && initialPrompt && params.sentText.trim() === initialPrompt);
}

export function shouldRendererAutoSendInitialPrompt(params: {
  coordinatedBy: string | undefined;
  initialPrompt: string | undefined;
  /** The prompt was written to the agent before an app restart but its echo
   *  was never confirmed; sending again would duplicate it in the resumed session. */
  deliveredBeforeRestart?: boolean;
}): boolean {
  const initialPrompt = params.initialPrompt?.trim();
  return Boolean(initialPrompt && !params.coordinatedBy && !params.deliveredBeforeRestart);
}

export type AutoSendVerifyOutcome = 'deliver' | 'retry' | 'giveup' | 'aborted';

/**
 * Decides what to do after an auto-sent prompt's echo-verification finishes.
 *
 * - `aborted`: verification was cut short because the prompt box unmounted after
 *              the prompt was written — the caller clears it like a delivery.
 * - `deliver`: the echo appeared — proceed with delivery (clear field, ack).
 * - `retry`:   the echo never appeared but retries remain — re-send.
 * - `giveup`:  the echo never appeared and retries are exhausted — stop.
 *
 * `aborted` takes precedence over `appeared` and the retry budget: an unmounted
 * box has no auto-send loop left to retry with.
 */
export function resolveAutoSendVerifyOutcome(params: {
  appeared: boolean;
  aborted: boolean;
  retryCount: number;
  maxRetries: number;
}): AutoSendVerifyOutcome {
  if (params.aborted) return 'aborted';
  if (params.appeared) return 'deliver';
  return params.retryCount < params.maxRetries ? 'retry' : 'giveup';
}
