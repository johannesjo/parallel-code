/** Canonical, renderer-independent data and transactions for both canvases. */
export { GRAPH_MAX_BYTES } from './graph-limits.js';
export {
  semanticNodeKinds,
  mapNodeKinds,
  reasoningStatuses,
  type MapNodeKind,
  type GraphSource,
  type MapNode,
  type MapLink,
  type NodeExplanation,
  type MapData,
  type GraphDocument,
  type MapOperation,
  type GraphUpdate,
} from './graph-types.js';
export {
  graphObject,
  validGraphId,
  parseGraphOperations,
  parseGraphUpdate,
} from './graph-parse.js';
export {
  nodeTrail,
  visibleNodes,
  validateGraph,
  applyMapOperations,
  type ApplyOptions,
} from './graph-apply.js';
export { graphDifference } from './graph-diff.js';
