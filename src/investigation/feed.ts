import { reasoningKinds, reasoningStatuses } from '../../electron/shared/reasoning-feed';
import { reasoningProfiles, type ReasoningProfile } from './profiles';
export { parseReasoningFeed } from '../../electron/shared/reasoning-feed';

const CONTINUE_RUN =
  'Continue the runId and revision returned by reasoning_read. Pass revision as expectedRevision. If empty, also supply newRunId with a new stable ID. Never reset a healthy graph to resolve a revision conflict.';
const FRESH_RUN =
  'The user asked for a new map: read first, pass the existing runId and revision as expectedRevision, and supply a distinct newRunId. The old graph is archived; insert a new root and do not carry old nodes over.';

export function reasoningPrompt(
  taskId: string,
  agentId: string,
  profile: ReasoningProfile = 'investigation',
  options: { fresh?: boolean } = {},
): string {
  const runPolicy = options.fresh ? FRESH_RUN : CONTINUE_RUN;
  return `Start the live reasoning map for task ${taskId}, agent session ${agentId}, using the parallel-code MCP tools reasoning_read and reasoning_update. Keep it updated as you continue this task.
Report concise public summaries of goals, hypotheses, options, experiments, evidence, decisions, and work. Do not supply private chain-of-thought or invent findings. Label untested hypotheses and uncertainty clearly.
Workflow: ${reasoningProfiles[profile].label}. ${reasoningProfiles[profile].instructions}
Read reasoning_read first. It returns one current graph, runId, revision, workflow, and the reporting guidance of every workflow. Unsent drafts are excluded. userEdited lists protected fields; * protects a user-created item. userDeleted records protected deletions. Ordinary operations must preserve them; intentionally overriding them requires overrideUser:true on that operation.
Before further investigation, call reasoning_update with an initial progress update summarizing the actual task. This confirms activation in the panel. ${runPolicy} On a stale revision, read again and reconsider the update.
Keep record IDs stable; use move to change parents and update to change fields. Changing workflow changes reporting guidance only. The MCP tools store the report; do not write report files yourself.
Initial update for an empty graph: {"runId":null,"newRunId":"stable-run-id","expectedRevision":0,"caption":"Brief public progress summary","operations":[{"type":"insert","node":{"id":"goal","kind":"goal","title":"Actual task goal","detail":"Brief scope and acceptance criteria","status":"unresolved"}}]}.
Replace example text with this task's actual content. Use runId and revision from reasoning_read for every update. A record has id, title (max 200 characters), detail (max 8000), and optional kind, status, parent, criteria (string array), result (string). Omit kind and status for a plain note; semantic notes require both kind and status. IDs use letters, digits, underscores or hyphens, max 128 characters. Keep exactly one root; every other record has an existing parent. Use the same operations as mindmap_update: insert, update with a changes object, move, remove (branch), insert_relation, update_relation, remove_relation, insert_explanation, update_explanation and remove_explanation. A patch includes only changed fields. Omission preserves a field; null clears optional fields. Changing kind must explicitly clear incompatible confidence or evaluations. Validate all references against the current graph.
Kinds: ${reasoningKinds.join(', ')}. Statuses: ${reasoningStatuses.join(', ')}.
For hypotheses, include optional confidence as a number from 0 to 1 (for example, 0.75 displays as 75%). This is your assessment that the hypothesis is correct given current evidence, not a measured probability. Briefly justify it in detail and revise it when evidence changes. Omit confidence when unassessed; do not infer it merely from status or invent precision. Other record kinds must omit it.
Options may report evaluations (max 200): [{"criterion":"Latency below 100 ms","assessment":"Measured p95 of 82 ms in the recorded benchmark; meets the target."}]. Use exact criterion names from the shared goal or question, with one assessment per criterion. Criterion names are nonempty text (max 1000); assessments are nonempty text (max 2000). Explain findings, tradeoffs, and uncertainty without inventing an overall score. Omit unassessed criteria; the comparison displays them as Not assessed. Put alternatives under the same parent to compare them together. Attach supporting sources to the option or its experiment/evidence records.
Optional sources on any record (max 20): [{"label":"Benchmark result","path":"results/benchmark.json","line":12},{"label":"Published dataset","url":"https://example.org/dataset"}]. Use actual inspected sources, replacing these examples. A source has a nonempty label (max 200) and either an HTTP(S) URL (max 2048, no credentials) or a task-relative file path (max 1024, no traversal) with an optional positive line number. Do not supply both. Sources provide provenance; explain what they support and their limitations in detail or result.
To add a relation, use {"type":"insert_relation","relation":{"id":"evidence-link","source":"evidence-id","target":"hypothesis-id","kind":"supports","rationale":"Why the evidence matters"}}. Relation kinds: supports, challenges, fits. All referenced IDs must exist.
When you set activeId to a hypothesis, also add one experiment or observation describing what would refute it and link it with a challenges relation; run or seek that check before marking the hypothesis supported.
Set activeId to the record currently being worked on; keep it on the hypothesis while testing it, because experiments and observations are results, not activity. Explicitly set it to null when idle, blocked, or finished; omission preserves it. Report meaningful changes and a final update that clears activeId. Revise assessments when evidence changes, including rejected or reopened hypotheses. Aim for the smallest graph that reports the work: add a record for a distinct idea, not to restate its parent or to log every file touched, and offer to expand a branch rather than pre-expanding it. Leave out redundancy, never findings. 200 records, 200 relations, 1000 updates and 1 MB per run are hard caps, not targets; a healthy graph is much smaller.\n`;
}
