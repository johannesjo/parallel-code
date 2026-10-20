/** Single source of truth for graph IDs and size limits; the JSON schema and runtime validators read these. */
export const GRAPH_ID_PATTERN = '^[a-zA-Z0-9_-]{1,128}$';
export const GRAPH_ID_REGEX = new RegExp(GRAPH_ID_PATTERN);
/** Serialized document cap for persisted and in-memory graphs (UTF-8 bytes of the JSON). */
export const GRAPH_MAX_BYTES = 2 * 1024 * 1024;
export const GRAPH_LIMITS = {
  nodes: 200,
  relations: 200,
  explanations: 200,
  operations: 1000,
  tombstones: 2000,
  caption: 2000,
  title: 200,
  detail: 8000,
  result: 8000,
  linkKind: 200,
  rationale: 2000,
  question: 8000,
  answer: 8000,
  criteria: 200,
  criterion: 1000,
  evaluations: 200,
  assessment: 2000,
  sources: 20,
  sourceLabel: 200,
  sourceUrl: 2048,
  sourcePath: 1024,
} as const;
