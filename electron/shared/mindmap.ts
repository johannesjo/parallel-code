import { validateGraph, type GraphDocument } from './graph.js';
export {
  semanticNodeKinds,
  mapNodeKinds,
  nodeTrail,
  visibleNodes,
  applyMapOperations,
  graphDifference,
  parseGraphUpdate as parseMindMapUpdate,
  type MapNodeKind,
  type MapNode,
  type MapLink,
  type MapData,
  type MapOperation,
  type GraphUpdate as MindMapUpdate,
} from './graph.js';
export type MindMapDocument = GraphDocument;
export function createMindMap(title = 'Central topic'): MindMapDocument {
  return {
    version: 1,
    revision: 0,
    records: [
      {
        id: crypto.randomUUID(),
        title: (title.trim() || 'Central topic').slice(0, 200),
        detail: '',
      },
    ],
    relations: [],
  };
}
export function restoreMindMap(value: unknown): MindMapDocument | undefined {
  try {
    validateGraph(value as GraphDocument);
    return structuredClone(value) as GraphDocument;
  } catch {
    return;
  }
}
