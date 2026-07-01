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
}): boolean {
  const initialPrompt = params.initialPrompt?.trim();
  return Boolean(initialPrompt && !params.coordinatedBy);
}

export type AutoSendVerifyOutcome = 'deliver' | 'retry' | 'giveup' | 'aborted';

export function shouldAcceptMissingInitialPromptEcho(params: {
  coordinatorMode: boolean | undefined;
  initialPrompt: string | undefined;
}): boolean {
  return Boolean(params.coordinatorMode && params.initialPrompt?.startsWith('[COORDINATOR MODE]'));
}

/**
 * Decides what to do after an auto-sent prompt's echo-verification finishes.
 *
 * - `aborted`: the send was superseded (signal aborted) — leave state untouched.
 * - `deliver`: the echo appeared — proceed with delivery (clear field, ack).
 * - `retry`:   the echo never appeared but retries remain — re-send.
 * - `giveup`:  the echo never appeared and retries are exhausted — stop.
 *
 * `aborted` takes precedence over `appeared`: a superseded send must not be
 * treated as delivered (or retried) even if the snippet happened to show up.
 */
export function resolveAutoSendVerifyOutcome(params: {
  appeared: boolean;
  aborted: boolean;
  retryCount: number;
  maxRetries: number;
  acceptMissingEcho?: boolean;
}): AutoSendVerifyOutcome {
  if (params.aborted) return 'aborted';
  if (params.appeared || params.acceptMissingEcho) return 'deliver';
  return params.retryCount < params.maxRetries ? 'retry' : 'giveup';
}
