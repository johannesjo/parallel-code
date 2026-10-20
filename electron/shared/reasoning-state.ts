import {
  applyMapOperations,
  type ApplyOptions,
  type GraphDocument,
  type GraphUpdate,
  type MapNode,
  type MapLink,
  type GraphSource,
} from './graph.js';
export type { NodeExplanation } from './graph.js';
export interface InvestigationRecord extends MapNode {
  kind?: Exclude<NonNullable<MapNode['kind']>, 'idea'>;
}
export type InvestigationSource = GraphSource;
export interface InvestigationRelation extends MapLink {
  kind: 'supports' | 'challenges' | 'fits';
  rationale: string;
}
/** Client command: revision and run identify the exact graph that was read. */
export interface ReasoningUpdate extends GraphUpdate {
  runId: string | null;
  newRunId?: string;
  caption?: string;
  /** Omitted preserves activity; null explicitly clears it. */
  activeId?: string | null;
}
/** Immutable accepted transaction. Actor and sequence are assigned by main. */
export interface InvestigationUpdate extends GraphUpdate {
  runId: string;
  sequence: number;
  actor: 'user' | 'agent';
  caption?: string;
  activeId?: string | null;
}
export interface Snapshot extends GraphDocument<InvestigationRecord, InvestigationRelation> {
  sequence: number;
  caption: string;
  activeId?: string;
  lastActiveId?: string;
}
export interface History {
  updates: InvestigationUpdate[];
  snapshots: Snapshot[];
}
export const emptyHistory = (): History => ({ updates: [], snapshots: [] });
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;
/** Key-order independent: an in-memory update must equal its re-parsed feed line. */
export const sameUpdate = (a: InvestigationUpdate, b: InvestigationUpdate): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function acceptUpdate(
  history: History,
  update: InvestigationUpdate,
  options: ApplyOptions = {},
): History {
  if (history.updates.length && history.updates[0].runId !== update.runId)
    throw new Error('Start a new run explicitly');
  const accepted = history.updates[update.sequence];
  if (accepted) {
    if (sameUpdate(accepted, update)) return history;
    throw new Error('Changed investigation history');
  }
  if (update.sequence !== history.updates.length) throw new Error('Unexpected sequence');
  const previous = history.snapshots[history.snapshots.length - 1];
  const graph = applyMapOperations<GraphDocument>(
    previous ?? { version: 1, revision: 0, records: [], relations: [] },
    update.operations,
    update.expectedRevision,
    update.actor,
    options,
  );
  if (graph.records.some((node) => node.kind && !node.status))
    throw new Error('Reasoning nodes with a semantic kind need a status.');
  if (
    graph.relations.some(
      (link) =>
        !['supports', 'challenges', 'fits'].includes(link.kind ?? '') ||
        typeof link.rationale !== 'string',
    )
  )
    throw new Error(
      'Reasoning relations need a kind of supports, challenges or fits, and a rationale.',
    );
  const ids = new Set(graph.records.map((node) => node.id));
  const activeId =
    update.activeId === undefined ? previous?.activeId : (update.activeId ?? undefined);
  if (update.activeId && !ids.has(update.activeId))
    throw new Error('Invalid active record reference');
  const lastActiveId = update.activeId ?? previous?.lastActiveId;
  const snapshot: Snapshot = {
    ...graph,
    records: graph.records as InvestigationRecord[],
    relations: graph.relations as InvestigationRelation[],
    sequence: update.sequence,
    caption: update.caption ?? previous?.caption ?? '',
    activeId: activeId && ids.has(activeId) ? activeId : undefined,
    lastActiveId: lastActiveId && ids.has(lastActiveId) ? lastActiveId : undefined,
  };
  return { updates: [...history.updates, update], snapshots: [...history.snapshots, snapshot] };
}
export function snapshotAt(history: History, sequence: number): Snapshot {
  const snapshot = history.snapshots[sequence];
  if (!snapshot) throw new Error('Snapshot unavailable');
  return snapshot;
}
