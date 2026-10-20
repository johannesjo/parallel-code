import type { MapOperation } from '../../electron/shared/graph';
import type { InvestigationUpdate } from './state';

/** Marker API a terminal exposes for its scrollback. */
export interface TranscriptMarks {
  mark: (key: string) => void;
  jump: (key: string) => boolean;
}

export const transcriptKey = (sequence: number) => `reasoning:${sequence}`;

function touches(operation: MapOperation, recordId: string): boolean {
  switch (operation.type) {
    case 'insert':
      return operation.node.id === recordId;
    case 'update':
    case 'move':
      return operation.id === recordId;
    case 'insert_relation':
      return operation.relation.source === recordId || operation.relation.target === recordId;
    default:
      return false;
  }
}

/** Sequence of the last agent update that changed or linked the record; user edits leave no transcript. */
export function lastAgentUpdateTouching(
  updates: readonly InvestigationUpdate[],
  recordId: string,
): number | undefined {
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i];
    if (update.actor === 'agent' && update.operations.some((op) => touches(op, recordId)))
      return update.sequence;
  }
  return undefined;
}
