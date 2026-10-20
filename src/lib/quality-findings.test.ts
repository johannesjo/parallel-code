import { describe, expect, it } from 'vitest';
import type { FileDiff } from './unified-diff-parser';
import {
  compileQualityFindingPrompt,
  createFixtureQualityFindingProvider,
  dismissQualityFinding,
  reconcileQualityFindings,
  reconcileQualityFindingsForDiff,
  resolveQualityFindings,
  selectedFindingIdsAfterSubmission,
  selectSubmittableFindings,
  type QualityFinding,
} from './quality-findings';

function finding(overrides: Partial<QualityFinding> = {}): QualityFinding {
  return {
    id: 'finding-1',
    source: 'fixture',
    ruleId: 'no-floating-promises',
    category: 'reliability',
    severity: 'warning',
    location: { filePath: 'src/app.ts', startLine: 10, startColumn: 3 },
    explanation: 'Await this promise or explicitly handle its rejection.',
    state: 'open',
    freshness: 'current',
    ...overrides,
  };
}

function diff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: 'src/app.ts',
    status: 'M',
    binary: false,
    hunks: [
      {
        oldStart: 9,
        oldCount: 2,
        newStart: 9,
        newCount: 3,
        lines: [
          { type: 'context', content: 'before', oldLine: 9, newLine: 9 },
          { type: 'add', content: 'runAsync();', oldLine: null, newLine: 10 },
          { type: 'context', content: 'after', oldLine: 10, newLine: 11 },
        ],
      },
    ],
    ...overrides,
  };
}

describe('createFixtureQualityFindingProvider', () => {
  it('supplies independent copies of fixture findings', async () => {
    const original = finding();
    const provider = createFixtureQualityFindingProvider([original]);
    const context = { reviewIdentity: 'task-1', diffIdentity: 'diff-1', files: [diff()] };

    const first = await provider.loadFindings(context);
    first[0].location.startLine = 99;
    const second = await provider.loadFindings(context);

    expect(second).toEqual([original]);
  });
});

describe('reconcileQualityFindings', () => {
  it('keeps a finding current when its location is represented in the diff', () => {
    const input = [finding()];
    expect(reconcileQualityFindings(input, [diff()])).toBe(input);
  });

  it.each([
    ['file is absent', []],
    ['file is deleted', [diff({ status: 'D', hunks: [] })]],
    ['location no longer matches', [diff()]],
  ])('marks a finding stale when the %s', (_name, files) => {
    const input =
      _name === 'location no longer matches'
        ? [finding({ location: { filePath: 'src/app.ts', startLine: 50 } })]
        : [finding()];
    expect(reconcileQualityFindings(input, files as FileDiff[])[0].freshness).toBe('stale');
  });

  it('can mark a stale finding current again after a matching diff refresh', () => {
    const stale = finding({ freshness: 'stale' });
    expect(reconcileQualityFindings([stale], [diff()])[0].freshness).toBe('current');
  });

  it('keeps provider-first findings pending until the diff loads', () => {
    const result = reconcileQualityFindingsForDiff([finding()], [], false);

    expect(result[0].freshness).toBe('pending');
    expect(selectSubmittableFindings(result, ['finding-1'])).toEqual([]);
  });

  it('returns current findings to pending during commit navigation', () => {
    const current = reconcileQualityFindingsForDiff([finding()], [diff()], true);
    const navigating = reconcileQualityFindingsForDiff(current, [], false);

    expect(current[0].freshness).toBe('current');
    expect(navigating[0].freshness).toBe('pending');
  });

  it('keeps findings pending after rejected diff loading', () => {
    const loading = reconcileQualityFindingsForDiff([finding()], [], false);
    const rejected = reconcileQualityFindingsForDiff(loading, [], false);

    expect(rejected).toBe(loading);
    expect(rejected[0].freshness).toBe('pending');
  });

  it('does not reuse a finding from another immutable diff at the same path and line', () => {
    const changedContent = diff({
      hunks: [
        {
          oldStart: 9,
          oldCount: 2,
          newStart: 9,
          newCount: 3,
          lines: [
            { type: 'context', content: 'before', oldLine: 9, newLine: 9 },
            { type: 'add', content: 'differentCall();', oldLine: null, newLine: 10 },
            { type: 'context', content: 'after', oldLine: 10, newLine: 11 },
          ],
        },
      ],
    });

    const reconciled = reconcileQualityFindingsForDiff(
      [finding()],
      [changedContent],
      true,
      'diff-before',
      'diff-after',
    );

    expect(reconciled[0].freshness).toBe('pending');
    expect(selectSubmittableFindings(reconciled, ['finding-1'])).toEqual([]);
  });

  it('requires the navigable start line for a ranged finding', () => {
    const ranged = finding({
      location: { filePath: 'src/app.ts', startLine: 8, endLine: 10 },
    });

    expect(reconcileQualityFindings([ranged], [diff()])[0].freshness).toBe('stale');
    expect(
      reconcileQualityFindings(
        [ranged],
        [
          diff({
            hunks: [
              {
                oldStart: 8,
                oldCount: 1,
                newStart: 8,
                newCount: 1,
                lines: [{ type: 'add', content: 'runAsync();', oldLine: null, newLine: 8 }],
              },
            ],
          }),
        ],
      )[0].freshness,
    ).toBe('current');
  });
});

describe('compileQualityFindingPrompt', () => {
  it('includes structured remediation fields for one or multiple findings', () => {
    const prompt = compileQualityFindingPrompt([
      finding(),
      finding({
        id: 'finding-2',
        ruleId: 'complexity',
        category: 'maintainability',
        severity: 'note',
        location: {
          filePath: 'src/util.ts',
          startLine: 4,
          startColumn: 2,
          endLine: 8,
          endColumn: 7,
        },
      }),
    ]);

    expect(prompt).toContain('[warning] [reliability] fixture/no-floating-promises');
    expect(prompt).toContain('Location: src/app.ts:10:3');
    expect(prompt).not.toContain('Fingerprint:');
    expect(prompt).toContain('[note] [maintainability] fixture/complexity');
    expect(prompt).toContain('Location: src/util.ts:4:2-8:7');
  });

  it('renders same-line column ranges without confusing the end column for a line', () => {
    const prompt = compileQualityFindingPrompt([
      finding({
        location: {
          filePath: 'src/app.ts',
          startLine: 10,
          startColumn: 3,
          endColumn: 7,
        },
      }),
    ]);

    expect(prompt).toContain('Location: src/app.ts:10:3-10:7');
  });
});

describe('finding review actions', () => {
  it('dismisses by state without dropping the stable provider ID', () => {
    const original = finding();
    const dismissed = dismissQualityFinding([original], original.id);

    expect(dismissed[0]).toMatchObject({
      id: original.id,
      state: 'dismissed',
    });
  });

  it('marks only successfully submitted findings resolved', () => {
    const submitted = finding();
    const untouched = finding({ id: 'finding-b' });
    const result = resolveQualityFindings([submitted, untouched], [submitted]);

    expect(result.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: 'finding-1', state: 'resolved' },
      { id: 'finding-b', state: 'open' },
    ]);
  });

  it('submits only selected open findings with current locations', () => {
    const current = finding();
    const stale = finding({ id: 'stale', freshness: 'stale' });
    const resolved = finding({ id: 'resolved', state: 'resolved' });

    expect(
      selectSubmittableFindings([current, stale, resolved], ['finding-1', 'stale', 'resolved']),
    ).toEqual([current]);
  });

  it('preserves unrelated selections after a single-card submission', () => {
    const remaining = selectedFindingIdsAfterSubmission(new Set(['finding-b', 'finding-c']), [
      finding(),
    ]);

    expect([...remaining]).toEqual(['finding-b', 'finding-c']);
  });

  it('removes only snapshotted bulk IDs from the latest selection', () => {
    const remaining = selectedFindingIdsAfterSubmission(
      new Set(['finding-1', 'finding-b', 'finding-c']),
      [finding(), finding({ id: 'finding-b' })],
    );

    expect([...remaining]).toEqual(['finding-c']);
  });
});
