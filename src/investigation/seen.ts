import { canonical } from '../../electron/shared/reasoning-state';
import type { MapOperation } from '../../electron/shared/graph';
import type { History, InvestigationRecord } from './state';

export type ChangeMark = 'new' | 'changed';

export interface UnseenChanges {
  marks: Map<string, ChangeMark>;
  /** Records the agent removed since the baseline, as they were when last seen. */
  removed: InvestigationRecord[];
}

/** Protection metadata is the user's own doing, not news from the agent. */
function content(record: InvestigationRecord): string {
  const { userEdited: _protection, ...rest } = record;
  return JSON.stringify(canonical(rest));
}

const byId = (records: readonly InvestigationRecord[] = []) =>
  new Map(records.map((record) => [record.id, record]));

const differs = (a: InvestigationRecord | undefined, b: InvestigationRecord) =>
  !a || content(a) !== content(b);

/** Records an operation adds or edits; removals are found by ID so a branch's descendants count. */
function operationTarget(operation: MapOperation): string | undefined {
  if (operation.type === 'insert') return operation.node.id;
  if (operation.type === 'update' || operation.type === 'move') return operation.id;
  return undefined;
}

/** What agent updates after `seen` did; user updates are skipped. Reads operations and IDs only,
 *  so a baseline far behind a 1000-update run costs no record comparisons. */
function agentActivity(history: History, seen: number) {
  const edited = new Set<string>();
  const removed = new Set<string>();
  for (let i = seen + 1; i < history.updates.length; i++) {
    const update = history.updates[i];
    if (update.actor !== 'agent') continue;
    for (const operation of update.operations) {
      const id = operationTarget(operation);
      if (id) edited.add(id);
    }
    const after = new Set(history.snapshots[i]?.records.map((record) => record.id));
    for (const record of history.snapshots[i - 1]?.records ?? [])
      if (!after.has(record.id)) removed.add(record.id);
  }
  return { edited, removed };
}

/**
 * What the agent changed since the user last looked at sequence `seen` (-1: before the first
 * update). A record counts once against the baseline, so an edit the agent reverted is not news.
 */
export function changesSince(history: History, seen: number): UnseenChanges {
  const activity = agentActivity(history, seen);
  const base = byId(history.snapshots[seen]?.records);
  const current = history.snapshots.at(-1)?.records ?? [];
  const marks = new Map<string, ChangeMark>();
  for (const record of current) {
    if (!activity.edited.has(record.id)) continue;
    const old = base.get(record.id);
    if (!old) marks.set(record.id, 'new');
    else if (differs(old, record)) marks.set(record.id, 'changed');
  }
  const ids = new Set(current.map((record) => record.id));
  const removed = [...base.values()].filter((r) => activity.removed.has(r.id) && !ids.has(r.id));
  return { marks, removed };
}

/**
 * The baseline to keep while the graph is on screen. It follows the graph while every update
 * after it was watched live (from `liveFrom` on), so changes the user saw happen are not news.
 * A catch-up read of updates that arrived while hidden freezes it until the user marks them seen.
 * A run seen for the first time adopts its current state: a whole new graph is not a diff.
 */
export function followSeen(seen: number | undefined, latest: number, liveFrom: number): number {
  if (seen === undefined || seen > latest) return latest;
  return seen >= liveFrom - 1 ? latest : seen;
}
