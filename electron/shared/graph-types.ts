/** Canonical, renderer-independent graph data: node kinds, statuses, records, and operations. */
export const semanticNodeKinds = [
  'goal',
  'question',
  'hypothesis',
  'option',
  'experiment',
  'observation',
  'decision',
  'work',
] as const;
export const mapNodeKinds = ['idea', ...semanticNodeKinds] as const;
export const reasoningStatuses = [
  'untested',
  'unresolved',
  'supported',
  'disputed',
  'rejected',
  'reopened',
  'proposed',
  'running',
  'complete',
  'observed',
] as const;
export type MapNodeKind = (typeof mapNodeKinds)[number];
export type GraphSource =
  | { label: string; url: string; path?: never; line?: never }
  | { label: string; path: string; line?: number; url?: never };
export interface ProtectedItem {
  id: string;
  /** Authored fields protected from ordinary agent edits; * protects a user-created item. */
  userEdited?: string[];
}
export interface MapNode extends ProtectedItem {
  parent?: string;
  title: string;
  detail: string;
  kind?: MapNodeKind;
  status?: (typeof reasoningStatuses)[number];
  criteria?: string[];
  evaluations?: { criterion: string; assessment: string }[];
  result?: string;
  confidence?: number;
  sources?: GraphSource[];
}
export interface MapLink extends ProtectedItem {
  source: string;
  target: string;
  kind?: string;
  rationale?: string;
}
export interface NodeExplanation extends ProtectedItem {
  nodeId: string;
  question: string;
  answer: string;
}
export interface MapData<N extends MapNode = MapNode, L extends MapLink = MapLink> {
  /** Array order defines sibling order; cross-links do not affect the navigation tree. */
  records: N[];
  relations: L[];
  explanations?: NodeExplanation[];
}
export interface GraphDocument<
  N extends MapNode = MapNode,
  L extends MapLink = MapLink,
> extends MapData<N, L> {
  version: 1;
  revision: number;
  /** Tombstones prevent ordinary agent inserts from resurrecting user deletions. */
  userDeleted?: Partial<Record<'records' | 'relations' | 'explanations', string[]>>;
}
type Patch<T> = { [K in keyof T]?: T[K] | null };
type NodeFields = Omit<MapNode, 'id' | 'parent' | 'userEdited'>;
type LinkFields = Omit<MapLink, 'id' | 'userEdited'>;
type Override = {
  overrideUser?: boolean;
  /** Restore mode (user undo/redo): set protection exactly instead of marking the edit. */
  userEdited?: string[];
  /** Restore mode: whether a removal leaves a tombstone; defaults to true for user removals. */
  tombstone?: boolean;
};
export type MapOperation = Override &
  (
    | { type: 'insert'; node: Omit<MapNode, 'userEdited'>; after?: string }
    | { type: 'update'; id: string; changes: Patch<NodeFields> }
    | { type: 'move'; id: string; parent: string; after?: string }
    | { type: 'remove'; id: string }
    | { type: 'insert_relation'; relation: Omit<MapLink, 'userEdited'> }
    | { type: 'update_relation'; id: string; changes: Patch<LinkFields> }
    | { type: 'remove_relation'; id: string }
    | { type: 'insert_explanation'; explanation: Omit<NodeExplanation, 'userEdited'> }
    | { type: 'update_explanation'; id: string; changes: { answer: string } }
    | { type: 'remove_explanation'; id: string }
  );
export interface GraphUpdate {
  expectedRevision: number;
  operations: MapOperation[];
}
export const nodeFields = [
  'title',
  'detail',
  'kind',
  'status',
  'criteria',
  'evaluations',
  'result',
  'confidence',
  'sources',
] as const;
export const linkFields = ['source', 'target', 'kind', 'rationale'] as const;
