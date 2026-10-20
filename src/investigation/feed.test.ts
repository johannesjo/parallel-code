import { expect, it } from 'vitest';
import { makeFixture } from './fixture';
import { parseReasoningFeed, reasoningPrompt } from './feed';
import { parseReasoningUpdate } from '../../electron/shared/reasoning-feed';
import { reasoningProfiles, type ReasoningProfile } from './profiles';
const updates = makeFixture().updates;
const encode = (events: unknown[]) => events.map((event) => JSON.stringify(event) + '\n').join('');
it.each(Object.keys(reasoningProfiles) as ReasoningProfile[])(
  'uses %s guidance with the single graph contract',
  (profile) => {
    const prompt = reasoningPrompt('task', 'agent', profile);
    expect(prompt).toContain(reasoningProfiles[profile].instructions);
    expect(prompt).toContain('expectedRevision');
    expect(prompt).toContain('overrideUser');
    expect(prompt).not.toContain('nextSequence');
    const prefix = 'Initial update for an empty graph: ';
    const example = prompt.split('\n').find((line) => line.startsWith(prefix));
    expect(example).toBeDefined();
    expect(() =>
      parseReasoningUpdate(JSON.parse(example?.slice(prefix.length, -1) ?? '{}')),
    ).not.toThrow();
  },
);
it('only asks to replace the graph when the user starts a new map', () => {
  expect(reasoningPrompt('task', 'agent')).toContain('Never reset a healthy graph');
  expect(reasoningPrompt('task', 'agent', 'investigation', { fresh: true })).toContain(
    'existing runId and revision',
  );
});
it('asks the agent to name a refuting check for the active hypothesis', () => {
  const prompt = reasoningPrompt('task', 'agent');
  expect(prompt).toContain('what would refute it');
  expect(prompt).toContain('challenges relation');
  expect(prompt).toContain('keep it on the hypothesis while testing it');
});
it('replays fixture transactions and retains snapshots across incremental reads', () => {
  const previous = parseReasoningFeed(encode(updates.slice(0, 3))).history;
  const next = parseReasoningFeed(encode(updates), previous);
  expect(next.error).toBeUndefined();
  expect(next.history.snapshots).toEqual(makeFixture().snapshots);
  expect(next.history.snapshots[0]).toBe(previous.snapshots[0]);
  expect(parseReasoningFeed(encode([updates[0], updates[2]]), previous).error).toContain(
    'sequence',
  );
});
it.each([
  { label: 'Bad', url: 'javascript:alert(1)' },
  { label: 'Bad', url: 'file:///etc/passwd' },
  { label: 'Bad', url: 'https://user:secret@example.org' },
  { label: 'Bad', url: 'https://example.org', path: 'data.json' },
  { label: 'Bad', url: 'https://example.org', line: 1 },
  { label: 'Bad', url: 'https://' },
  { label: 'Bad', url: 'https://example.org/\nfile' },
  { label: 'Bad', path: '/etc/passwd' },
  { label: 'Bad', path: 'results/../secret' },
  { label: 'Bad', path: 'results\\secret' },
  { label: 'Bad', path: 'results/data.json', line: 0 },
  { label: 'Bad', path: 'results/data.json', line: 1.5 },
  { label: '', url: 'https://example.org' },
])('rejects invalid sources while retaining the accepted graph: %j', (source) => {
  const previous = parseReasoningFeed(encode([updates[0]])).history;
  const result = parseReasoningFeed(
    encode([
      updates[0],
      { ...updates[1], operations: [{ type: 'update', id: 'G1', changes: { sources: [source] } }] },
    ]),
    previous,
  );
  expect(result.error).toBeTruthy();
  expect(result.history).toBe(previous);
});
it.each([undefined, 0, 0.73, 1])('accepts optional hypothesis confidence %s', (confidence) => {
  const node = {
    id: 'candidate',
    parent: 'G1',
    kind: 'hypothesis',
    title: 'Candidate',
    detail: '',
    status: 'untested',
    confidence,
  };
  const result = parseReasoningFeed(
    encode([updates[0], { ...updates[1], activeId: null, operations: [{ type: 'insert', node }] }]),
  );
  expect(result.error).toBeUndefined();
  expect(
    result.history.snapshots[1].records.find((node) => node.id === 'candidate')?.confidence,
  ).toBe(confidence);
});
it.each([-0.1, 1.1, '75%', null])('rejects invalid inserted confidence %s', (confidence) => {
  const node = {
    id: 'candidate',
    parent: 'G1',
    kind: 'hypothesis',
    title: 'Candidate',
    detail: '',
    status: 'untested',
    confidence,
  };
  expect(
    parseReasoningFeed(
      encode([updates[0], { ...updates[1], operations: [{ type: 'insert', node }] }]),
    ).error,
  ).toBeTruthy();
});
it('validates option evaluations and preserves sources on partial reassessment', () => {
  const node = {
    id: 'option',
    parent: 'G1',
    kind: 'option',
    title: 'Queue',
    detail: 'Tradeoffs',
    status: 'proposed',
    sources: [{ label: 'Benchmark', path: 'results/a.json' }],
    evaluations: [{ criterion: 'Latency', assessment: 'Measured 82 ms' }],
  };
  const inserted = { ...updates[1], activeId: null, operations: [{ type: 'insert', node }] };
  const patched = {
    ...updates[2],
    activeId: null,
    operations: [
      {
        type: 'update',
        id: 'option',
        changes: { evaluations: [{ criterion: 'Latency', assessment: 'Measured 90 ms' }] },
      },
    ],
  };
  const result = parseReasoningFeed(encode([updates[0], inserted, patched]));
  expect(result.error).toBeUndefined();
  expect(result.history.snapshots[2].records.find((node) => node.id === 'option')).toMatchObject({
    sources: node.sources,
    evaluations: [{ criterion: 'Latency', assessment: 'Measured 90 ms' }],
  });
});
it('bounds history and validates the complete graph', () => {
  expect(parseReasoningFeed(' '.repeat(1024 * 1024 + 1)).error).toContain('1 MB');
  expect(parseReasoningFeed('\n'.repeat(1001)).error).toContain('1000 updates');
  expect(parseReasoningFeed(encode([{ ...updates[0], activeId: 'missing' }])).error).toContain(
    'reference',
  );
  expect(
    parseReasoningFeed(
      encode([
        {
          ...updates[0],
          operations: [
            {
              type: 'insert',
              node: { id: 'typed', kind: 'question', title: 'Question', detail: '' },
            },
          ],
        },
      ]),
    ).error,
  ).toContain('semantic kind');
});
it('accepts and replays plain notes using the shared mindmap representation', () => {
  const node = { id: 'plain', title: 'Plain note', detail: '' };
  const result = parseReasoningFeed(
    encode([{ ...updates[0], activeId: null, operations: [{ type: 'insert', node }] }]),
  );
  expect(result.error).toBeUndefined();
  expect(result.history.snapshots[0].records).toEqual([expect.objectContaining(node)]);
  expect(result.history.snapshots[0].records[0].kind).toBeUndefined();
  expect(result.history.snapshots[0].records[0].status).toBeUndefined();
});
