import type { Snapshot } from './state';
import { exportGraphAs, exportGraphHtml, type ExportFormat } from '../graph/graphExport';

/** Names the reasoning report inside an exported HTML page. */
const DATA_FORMAT = 'parallel-code-reasoning';
const FALLBACK_NAME = 'reasoning-graph';

const graphTitle = (snapshot: Snapshot): string =>
  snapshot.records.find((node) => !node.parent)?.title || 'Reasoning graph';

/** Revision, caption and export time, e.g. for a heading. */
function exportSubtitle(snapshot: Snapshot, date = new Date()): string {
  return [`Revision ${snapshot.revision}`, snapshot.caption, date.toLocaleString()]
    .filter(Boolean)
    .join(' · ');
}

const options = (snapshot: Snapshot, date?: Date) => ({
  graph: snapshot,
  title: graphTitle(snapshot),
  subtitle: exportSubtitle(snapshot, date),
  fallback: FALLBACK_NAME,
  dataFormat: DATA_FORMAT,
});

/** Save the current canvas plus complete graph data as a self-contained, offline HTML file. */
export function exportReasoningGraph(svg: SVGSVGElement, snapshot: Snapshot, date?: Date): void {
  exportGraphHtml(svg, options(snapshot, date));
}

/** Export in the chosen format; the HTML page needs the rendered canvas. */
export function exportReasoningGraphAs(
  format: ExportFormat,
  snapshot: Snapshot,
  svg: SVGSVGElement | null,
): void {
  exportGraphAs(format, options(snapshot), svg);
}
