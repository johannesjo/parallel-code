/**
 * Check cards: a project check shown as a card. Exit-code mode shows pass or
 * fail; JSON mode fills the card's slots from the object the check wrote to
 * `PC_OUT_FILE`. Pure helpers; the run itself is `src/store/card-checks.ts`.
 */

import type { CardCheckResult, VerificationRun } from '../ipc/types';
import { parseCardValues } from './card-publish';
import type { SlotValue } from './card-slots';
import { freeCardId, type CardDefinition } from './cards';

const RESULT_SLOT = 'result';

/** A new exit-code card for a project check, run on demand, with an id not in `taken`. */
export function checkCard(
  check: { id: string; name: string },
  taken: ReadonlySet<string> = new Set(),
): CardDefinition {
  return {
    // Check ids run to 64 characters, so two long ones can share a cut-off card id.
    id: freeCardId(`check-${check.id}`, taken),
    name: check.name,
    description: '',
    // Finish is where a stale check result costs most; Run stays on the card either way.
    source: { kind: 'check', checkId: check.id, mode: 'exit-code', trigger: 'finish' },
    slots: [{ id: RESULT_SLOT, type: 'status', label: 'Result' }],
    enabled: true,
    // It runs when Finish opens, so its result shows there too.
    showAtFinish: true,
  };
}

/** "41 s" or "3 min": the time a run took, for its status row. */
function duration(run: VerificationRun): string {
  const ms = Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt);
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** The new values, or why the card keeps its previous ones. */
export type CheckCardOutcome = { values: Record<string, SlotValue> } | { error: string };

function passFail(card: CardDefinition, run: VerificationRun): CheckCardOutcome {
  const slot = card.slots.find((entry) => entry.type === 'status');
  if (!slot) return { error: 'This card has no status slot to show the result in.' };
  const passed = run.status === 'passed';
  const row = {
    state: passed ? ('ok' as const) : ('fail' as const),
    text: passed ? 'Passed' : 'Failed',
    value: `exit ${run.exitCode ?? '?'} · ${duration(run)}`,
  };
  return { values: { [slot.id]: { type: 'status', rows: [row] } } };
}

function fromOutput(card: CardDefinition, result: CardCheckResult): CheckCardOutcome {
  if (result.error || !result.output) return { error: result.error ?? 'PC_OUT_FILE missing' };
  try {
    return { values: parseCardValues(card, result.output) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What a finished run shows. A pass or fail is the exit-code card's value; a
 * JSON card needs a passed run and a file that fits its slots. A run that timed
 * out, was cancelled or could not start leaves the previous values.
 */
export function checkCardOutcome(card: CardDefinition, result: CardCheckResult): CheckCardOutcome {
  const { run } = result;
  if (run.status !== 'passed' && run.status !== 'failed')
    return { error: run.message ?? run.status.replace('_', ' ') };
  if (card.source.kind === 'check' && card.source.mode === 'json')
    return run.status === 'passed'
      ? fromOutput(card, result)
      : { error: run.message ?? `exit ${run.exitCode ?? '?'}` };
  return passFail(card, run);
}

/** HEAD or the uncommitted state moved while the check ran, so its result covers neither. */
export function codeChangedDuringRun(run: VerificationRun): boolean {
  return run.headShaAfter !== run.headSha || run.dirtyAfter !== run.dirty;
}
