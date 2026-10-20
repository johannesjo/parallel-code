import { createMemo } from 'solid-js';
import { GraphCanvas, type GraphProps } from '../graph/GraphCanvas';
import { fadedRecords, recordEmphasis, type InvestigationRecord, type Snapshot } from './state';
import { notePresentation } from './presentation';

type Props = Omit<GraphProps<InvestigationRecord>, 'snapshot' | 'appearance' | 'emphasis'> & {
  snapshot: Snapshot;
};

/** Investigation supplies semantics; the shared canvas owns layout and interaction. */
export function InvestigationGraph(props: Props) {
  const emphasis = createMemo(() => recordEmphasis(props.snapshot));
  const faded = createMemo(() => fadedRecords(props.snapshot.records));
  return (
    <GraphCanvas
      {...props}
      showActivity
      label="Branching investigation. Arrow keys pan; plus and minus zoom."
      emphasis={emphasis()}
      faded={faded()}
      appearance={(node, compact) => ({
        ...notePresentation(node.kind, compact),
        kind: node.kind ?? 'idea',
        status: node.status,
        confidence: node.confidence,
      })}
    />
  );
}
