import { REASONING_MAX_BYTES, REASONING_MAX_UPDATES } from './reasoning.js';
import { graphObject, validGraphId, parseGraphOperations } from './graph.js';
import { GRAPH_LIMITS } from './graph-limits.js';
import {
  acceptUpdate,
  emptyHistory,
  sameUpdate,
  type History,
  type InvestigationUpdate,
  type ReasoningUpdate,
} from './reasoning-state.js';
export { semanticNodeKinds as reasoningKinds, reasoningStatuses } from './graph.js';

function parse(value: unknown, event: boolean): ReasoningUpdate | InvestigationUpdate {
  if (!graphObject(value)) throw new Error('Expected a reasoning update.');
  const allowed = [
    'runId',
    'expectedRevision',
    'operations',
    'caption',
    'activeId',
    ...(event ? ['actor', 'sequence'] : ['newRunId']),
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unknown reasoning update field.');
  if (
    !(validGraphId(value.runId) || (!event && value.runId === null)) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    Number(value.expectedRevision) < 0
  )
    throw new Error('Supply runId and expectedRevision from reasoning_read.');
  if (
    value.caption !== undefined &&
    (typeof value.caption !== 'string' || value.caption.length > GRAPH_LIMITS.caption)
  )
    throw new Error('Invalid caption.');
  if (value.activeId !== undefined && value.activeId !== null && !validGraphId(value.activeId))
    throw new Error('Invalid activeId.');
  const common = {
    expectedRevision: Number(value.expectedRevision),
    operations: parseGraphOperations(value.operations),
    ...(value.caption !== undefined ? { caption: value.caption as string } : {}),
    ...(value.activeId !== undefined ? { activeId: value.activeId as string | null } : {}),
  };
  if (event) {
    if (
      !Number.isSafeInteger(value.sequence) ||
      Number(value.sequence) < 0 ||
      !['user', 'agent'].includes(String(value.actor))
    )
      throw new Error('Invalid accepted transaction.');
    return {
      ...common,
      runId: value.runId as string,
      sequence: Number(value.sequence),
      actor: value.actor as 'user' | 'agent',
    };
  }
  if (
    value.newRunId !== undefined &&
    (!validGraphId(value.newRunId) || value.newRunId === value.runId)
  )
    throw new Error('Choose a new stable run ID.');
  return {
    ...common,
    runId: value.runId as string | null,
    ...(value.newRunId !== undefined ? { newRunId: value.newRunId as string } : {}),
  };
}
export function parseReasoningUpdate(value: unknown): ReasoningUpdate {
  return parse(value, false) as ReasoningUpdate;
}
export function parseReasoningFeed(
  raw: string,
  previous: History = emptyHistory(),
): { history: History; error?: string; pending: boolean } {
  let history = emptyHistory();
  let line = 0;
  const pending = raw.length > 0 && !raw.endsWith('\n');
  try {
    if (new TextEncoder().encode(raw).length > REASONING_MAX_BYTES)
      throw new Error('Feed exceeds 1 MB');
    const lines = raw.split('\n');
    lines.pop();
    if (lines.length > REASONING_MAX_UPDATES)
      throw new Error(`Feed exceeds ${REASONING_MAX_UPDATES} updates; start a new run`);
    for (const rawLine of lines) {
      line++;
      if (!rawLine.trim()) continue;
      const next = parse(JSON.parse(rawLine) as unknown, true) as InvestigationUpdate;
      const old = previous.updates[next.sequence];
      if (old?.runId === next.runId && !sameUpdate(old, next))
        throw new Error('Changed investigation history');
      if (old?.runId === next.runId && next.sequence === history.updates.length)
        history = {
          updates: [...history.updates, old],
          snapshots: [...history.snapshots, previous.snapshots[next.sequence]],
        };
      else history = acceptUpdate(history, next, { strictRelations: false });
    }
    if (
      previous.updates.length &&
      (!history.updates.length ||
        (history.updates[0]?.runId === previous.updates[0]?.runId &&
          history.updates.length < previous.updates.length))
    )
      throw new Error('Feed was truncated; retaining the last valid graph');
  } catch (error) {
    if (
      (!history.updates.length || history.updates[0]?.runId === previous.updates[0]?.runId) &&
      history.updates.length <= previous.updates.length
    )
      history = previous;
    return {
      history,
      error: `Line ${line || 1}: ${error instanceof Error ? error.message : 'Invalid update'}`,
      pending,
    };
  }
  if (
    history.updates.length === previous.updates.length &&
    history.updates[0]?.runId === previous.updates[0]?.runId
  )
    history = previous;
  return { history, pending };
}
