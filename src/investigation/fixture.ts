import {
  acceptUpdate,
  emptyHistory,
  type InvestigationRecord as Record,
  type InvestigationRelation,
  type History,
} from './state';
import { graphDifference } from '../../electron/shared/graph';

/** Concise narrative input for the development fixture, never a persisted format. */
interface StoryStep {
  runId: string;
  sequence: number;
  caption: string;
  activeId?: string;
  records?: Record[];
  relations?: InvestigationRelation[];
}

const record = (
  id: string,
  parent: string | undefined,
  kind: Record['kind'],
  title: string,
  status: Record['status'],
  detail: string,
): Record => ({ id, parent, kind, title, status, detail });
const retry = record(
  'H2',
  'BUG',
  'hypothesis',
  'Retry reapplication',
  'untested',
  'A retry may apply one logical task twice. A duplicate alone cannot isolate this path.',
);
const narrow = record(
  'H22',
  'H2',
  'hypothesis',
  'Late acknowledgement',
  'rejected',
  'Initially ruled out by T4; the controls will later be challenged.',
);
const test = record(
  'T4',
  'H2',
  'experiment',
  'Repeat the retry path',
  'running',
  'Scripted experiment: retry enabled, with storage state carried between runs. No real test artifact has been verified.',
);

export const LAST_STORY_SEQUENCE = 8;

/** All claims below are illustrative, agent-reported fixture data, not findings about this repository. */
export function makeFixture(workload: 0 | 30 | 100 = 0) {
  const updates: StoryStep[] = [
    {
      runId: 'duplicate-task-demo',
      sequence: 0,
      caption: 'One bug, three alternatives. None has been established.',
      records: [
        record(
          'BUG',
          undefined,
          'question',
          'Why duplicate tasks?',
          'unresolved',
          'A user sees two tasks after one submission. Explore network delivery, retry handling, and storage.',
        ),
        record(
          'H1',
          'BUG',
          'hypothesis',
          'Network redelivery',
          'untested',
          'Two deliveries may carry the same task. Compare request identity before assigning blame.',
        ),
        retry,
        record(
          'H3',
          'BUG',
          'hypothesis',
          'Storage duplication',
          'unresolved',
          'One write may produce two rows. Read this branch while the retry interpretation changes; your view should stay put.',
        ),
      ],
    },
    {
      runId: 'duplicate-task-demo',
      sequence: 1,
      caption: 'E21 records a duplicate. It initially supports H2, but also fits H1 and H3.',
      activeId: 'T4',
      records: [
        test,
        record(
          'E21',
          'T4',
          'observation',
          'Duplicate seen',
          'observed',
          'Fixture report: two rows appeared with retry enabled. This observation survives the later correction. Agent-reported; no execution artifact checked.',
        ),
        { ...retry, status: 'supported' },
      ],
      relations: [
        {
          id: 'E21-H2',
          source: 'E21',
          target: 'H2',
          kind: 'supports',
          rationale:
            'The duplicate appeared with retries enabled; causation has not been isolated.',
        },
        {
          id: 'E21-H1',
          source: 'E21',
          target: 'H1',
          kind: 'fits',
          rationale: 'Network redelivery could produce the same observation.',
        },
        {
          id: 'E21-H3',
          source: 'E21',
          target: 'H3',
          kind: 'fits',
          rationale: 'Storage duplication could also produce these rows.',
        },
      ],
    },
    {
      runId: 'duplicate-task-demo',
      sequence: 2,
      caption: 'H2 splits into two candidates. T4 provisionally rules out late acknowledgement.',
      activeId: 'H21',
      records: [
        {
          ...test,
          status: 'complete',
          result: 'Two rows appeared with retry enabled. The control setup has not been verified.',
        },
        record(
          'H21',
          'H2',
          'hypothesis',
          'Missing idempotency',
          'unresolved',
          'The retry may lack a stable operation key. Compare keys across the two applications.',
        ),
        narrow,
        record(
          'D3',
          'H2',
          'decision',
          'Target the retry path',
          'complete',
          'Provisional choice based on E21. Revisit this decision if the retry controls do not hold.',
        ),
        record(
          'W8',
          'D3',
          'work',
          'Add a retry guard',
          'proposed',
          'Proposed implementation work following D3. It has not started; completion requires a controlled regression test and unchanged sync behavior.',
        ),
      ],
    },
    {
      runId: 'duplicate-task-demo',
      sequence: 3,
      caption: 'E22 challenges T4’s controls. H2 is disputed; H22 reopens. E21 is unchanged.',
      activeId: 'H22',
      records: [
        record(
          'E22',
          'T4',
          'observation',
          'Controls were mixed',
          'observed',
          'Fixture review: storage state was not reset between retry and control runs. T4 cannot isolate retry handling.',
        ),
        { ...retry, status: 'disputed' },
        record(
          'D3',
          'H2',
          'decision',
          'Target the retry path',
          'disputed',
          'E22 challenges the controls behind this choice. The decision needs review; it is not silently replaced.',
        ),
        record(
          'W8',
          'D3',
          'work',
          'Add a retry guard',
          'disputed',
          'The premise for this proposed work needs review. No implementation or pause has been reported.',
        ),
        {
          ...narrow,
          status: 'reopened',
          detail:
            'T4 did not isolate the retry path. Its earlier rejection no longer holds; late acknowledgement is open again.',
        },
      ],
      relations: [
        {
          id: 'E21-H2',
          source: 'E21',
          target: 'H2',
          kind: 'fits',
          rationale: 'Revised at S6: mixed controls prevent the earlier supporting interpretation.',
        },
        {
          id: 'E22-T4',
          source: 'E22',
          target: 'T4',
          kind: 'challenges',
          rationale: 'Storage state differed between runs; the control was not independent.',
        },
      ],
    },
    {
      runId: 'duplicate-task-demo',
      sequence: 4,
      caption:
        'T5 starts a clean-state comparison on H22. Starting work does not change confidence.',
      activeId: 'T5',
      records: [
        record(
          'T5',
          'H22',
          'experiment',
          'Isolate delayed ACK',
          'running',
          'Declared fixture work: reset storage, retain the operation key, and delay acknowledgement only.',
        ),
      ],
    },
    {
      runId: 'duplicate-task-demo',
      sequence: 5,
      caption: 'T5 reports no duplicate in the clean run. More evidence is needed; T6 is proposed.',
      records: [
        record(
          'T5',
          'H22',
          'experiment',
          'Isolate delayed ACK',
          'complete',
          'Agent-reported fixture result: no duplicate in one clean run. This is not enough to reject the branch.',
        ),
        record(
          'E23',
          'T5',
          'observation',
          'Clean run: one row',
          'observed',
          'One illustrative run produced one row. The fixture contains no independently verified artifact.',
        ),
        record(
          'T6',
          'H21',
          'experiment',
          'Compare operation keys',
          'proposed',
          'Next useful experiment: log the operation key on both applications, while resetting storage between trials.',
        ),
      ],
    },
  ];
  const goal: Record = {
    ...record(
      'G1',
      undefined,
      'goal',
      'Eliminate duplicate tasks',
      'unresolved',
      'Remove duplicate tasks without changing the sync protocol.',
    ),
    criteria: [
      'One logical submission creates one task.',
      'Existing sync behavior and protocol remain unchanged.',
      'Validate the fix with controlled regression evidence.',
    ],
  };
  const bug = updates[0].records?.[0];
  if (bug) bug.parent = 'G1';
  const finalCount = new Set(updates.flatMap((u) => u.records?.map((r) => r.id) ?? [])).size + 1;
  for (let i = 0; i < workload - finalCount; i++) {
    updates[0].records?.push(
      record(
        `LOAD${i + 1}`,
        `H${(i % 3) + 1}`,
        'observation',
        `Load sample ${i + 1}`,
        'observed',
        'Synthetic workload filler. It carries no evidence for or against a hypothesis.',
      ),
    );
  }
  const opening = updates[0].records ?? [];
  const discoveries: StoryStep[] = opening.slice(0, 4).map((item, sequence) => ({
    runId: 'duplicate-task-demo',
    sequence,
    activeId: item.id,
    caption:
      sequence === 0
        ? 'Start with the reported bug. No hypotheses recorded yet.'
        : `Investigating ${item.id}: ${item.title}. A candidate, not a conclusion.`,
    records: sequence === 0 ? [goal, item] : sequence === 3 ? [item, ...opening.slice(4)] : [item],
  }));
  return [
    ...discoveries,
    ...updates.slice(1).map((update) => ({ ...update, sequence: update.sequence + 3 })),
  ].reduce((history: History, step) => {
    const before = history.snapshots.at(-1) ?? {
      version: 1 as const,
      revision: 0,
      records: [],
      relations: [],
    };
    const records = new Map(before.records.map((node) => [node.id, node]));
    const relations = new Map(before.relations.map((link) => [link.id, link]));
    for (const node of step.records ?? []) records.set(node.id, node);
    for (const link of step.relations ?? []) relations.set(link.id, link);
    return acceptUpdate(history, {
      runId: step.runId,
      sequence: step.sequence,
      actor: 'agent',
      expectedRevision: before.revision,
      caption: step.caption,
      activeId: step.activeId ?? null,
      operations: graphDifference(before, {
        ...before,
        records: [...records.values()],
        relations: [...relations.values()],
      }),
    });
  }, emptyHistory());
}
