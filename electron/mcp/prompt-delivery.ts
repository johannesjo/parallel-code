/** Why a prompt for a coordinated task has not reached its agent yet. */
export type PromptBlocker = 'agent_startup' | 'user_activity' | 'agent_busy';

/**
 * Delivery state of the latest prompt for a coordinated task. Absent when the
 * prompt was submitted and the agent visibly started, or nothing was sent.
 * `unconfirmed`: Enter was written, yet the agent sits at an empty prompt with
 * no evidence it took the prompt (a TUI can drop input typed while it repaints).
 */
export type PromptDelivery =
  | { state: 'queued'; blockedBy: PromptBlocker; sinceMs: number }
  | { state: 'unconfirmed'; sinceMs: number };

export interface PromptDeliveryInput {
  now: number;
  /** Set while an assignment or follow-up waits to be typed. */
  queuedAt?: number;
  blockedBy: PromptBlocker;
  /** When the latest prompt's Enter was written. */
  submittedAt?: number;
  /** When the agent showed it took that prompt (hook or busy marker). */
  startedAt?: number;
  /** The agent renders its empty input prompt (or printed nothing since the submit). */
  awaitingInput: boolean;
}

/** Long enough for a TUI to start its turn and show a busy marker or hook. */
export const START_CONFIRM_MS = 20_000;
/** Undelivered this long, a child is reported as stalled to its parent. */
export const PROMPT_STALL_MS = 60_000;

export function promptDelivery(input: PromptDeliveryInput): PromptDelivery | undefined {
  const { now, queuedAt, submittedAt, startedAt } = input;
  if (queuedAt !== undefined) {
    return { state: 'queued', blockedBy: input.blockedBy, sinceMs: now - queuedAt };
  }
  if (submittedAt === undefined || startedAt !== undefined || !input.awaitingInput) return;
  const sinceMs = now - submittedAt;
  return sinceMs >= START_CONFIRM_MS ? { state: 'unconfirmed', sinceMs } : undefined;
}

/** A busy agent drains its queue when its turn ends, so that wait is not a stall. */
export function isStalled(delivery: PromptDelivery | undefined, agentIdle: boolean): boolean {
  if (!delivery || delivery.sinceMs < PROMPT_STALL_MS) return false;
  if (delivery.state === 'unconfirmed') return true;
  return delivery.blockedBy !== 'agent_busy' || agentIdle;
}
