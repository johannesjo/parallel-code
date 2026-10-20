import { visibleNodes } from '../graph/model';
import type { InvestigationRecord, Snapshot } from '../../electron/shared/reasoning-state';
export {
  acceptUpdate,
  emptyHistory,
  snapshotAt,
  type InvestigationRecord,
  type InvestigationSource,
  type InvestigationRelation,
  type InvestigationUpdate,
  type Snapshot,
  type History,
} from '../../electron/shared/reasoning-state';

export function visibleRecords(
  snapshot: Snapshot,
  collapsed: ReadonlySet<string>,
): InvestigationRecord[] {
  return visibleNodes(snapshot.records, collapsed);
}

type RecordEmphasis = 'working' | 'path' | 'settled' | 'background' | 'normal';

/** Agent-reported confidence below this reads as unlikely; the branch recedes. */
const lowConfidence = 0.4;

/** Rejected notes and unlikely hypotheses recede together with everything beneath them. */
export function fadedRecords(records: InvestigationRecord[]): Set<string> {
  const faded = new Set<string>();
  const fade = (id: string) => {
    if (faded.has(id)) return;
    faded.add(id);
    for (const child of records) if (child.parent === id) fade(child.id);
  };
  for (const record of records) {
    const unlikely = record.kind === 'hypothesis' && (record.confidence ?? 1) < lowConfidence;
    if (record.status === 'rejected' || unlikely) fade(record.id);
  }
  return faded;
}

/** Attention follows declared work; neither selection nor elapsed time implies activity. */
export function recordEmphasis(snapshot: Snapshot): Map<string, RecordEmphasis> {
  const byId = new Map(snapshot.records.map((record) => [record.id, record]));
  const settled = (record: InvestigationRecord) =>
    record.status === 'complete' || record.status === 'rejected';
  const active = snapshot.activeId ? byId.get(snapshot.activeId) : undefined;
  const workingId = active && !settled(active) ? active.id : undefined;
  const path = new Set<string>();
  let id = workingId;
  while (id && !path.has(id)) {
    path.add(id);
    id = byId.get(id)?.parent;
  }
  return new Map(
    snapshot.records.map((record): [string, RecordEmphasis] => {
      if (settled(record)) return [record.id, 'settled'];
      if (record.id === workingId) return [record.id, 'working'];
      if (path.has(record.id)) return [record.id, 'path'];
      return [record.id, workingId ? 'background' : 'normal'];
    }),
  );
}
