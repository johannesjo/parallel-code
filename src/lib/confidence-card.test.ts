import { describe, expect, it } from 'vitest';
import { confidenceCard, restoreCardDefinitions, restoreTaskCards } from './cards';
import {
  cardConfidence,
  holdsMergeEvidence,
  isClassicRating,
  ratingCardValues,
  restoreRatedTaskCards,
} from './confidence-card';

/** A rating as an older app saved it in `task.confidence`, every part filled. */
const SAVED_RATING = {
  scores: [
    { label: 'Correct', score: 82, why: 'Read every caller.', verified: ['npm test'] },
    { label: 'Complete', score: 55, why: 'Docs not updated.' },
  ],
  findings: [
    { kind: 'gap', text: 'Docs miss the new flag', file: 'docs/a.md', axis: 'Complete' },
    { kind: 'risk', text: 'Retry may loop' },
    { kind: 'unverified', text: 'Windows paths untested' },
    { kind: 'extra', text: 'Renamed a helper', file: 'src/b.ts' },
  ],
  source: 'confidence skill',
  asked: 'Make retries back off',
  changes: [{ now: 'Retries back off', before: 'Retries failed at once', tested: 'unit test' }],
  keyLine: { file: 'src/retry.ts', line: 42, why: 'The backoff starts here' },
  publishedAt: 1_000,
  fingerprint: 'fp-1',
  origin: 'review',
  headSha: 'a'.repeat(40),
};

describe('restoreRatedTaskCards', () => {
  it('moves a rating saved before the card held it into the Confidence card', () => {
    const cards = restoreRatedTaskCards(undefined, structuredClone(SAVED_RATING));
    expect(cards?.confidence).toEqual({
      values: {
        scores: { type: 'scores', scores: SAVED_RATING.scores },
        findings: {
          type: 'items',
          items: [
            {
              text: 'Docs miss the new flag',
              severity: 'block',
              file: 'docs/a.md',
              tag: 'Complete',
            },
            { text: 'Retry may loop', severity: 'block' },
            { text: 'Windows paths untested', severity: 'warn' },
            { text: 'Renamed a helper', severity: 'info', file: 'src/b.ts' },
          ],
        },
        changes: {
          type: 'items',
          items: [
            {
              text: 'Retries back off',
              severity: 'info',
              detail: 'Retries failed at once',
              tag: 'unit test',
            },
          ],
        },
        keyLine: {
          type: 'items',
          items: [{ text: 'The backoff starts here', severity: 'info', file: 'src/retry.ts:42' }],
        },
        asked: { type: 'line', text: 'Make retries back off' },
      },
      at: 1_000,
      fingerprint: 'fp-1',
      source: 'confidence skill',
      origin: 'review',
      headSha: 'a'.repeat(40),
    });
  });

  it('reads a moved rating back as it was saved, a gap reading as a risk', () => {
    const cards = restoreRatedTaskCards(undefined, structuredClone(SAVED_RATING));
    expect(cardConfidence(confidenceCard(true), cards?.confidence)).toEqual({
      ...SAVED_RATING,
      findings: [
        { kind: 'risk', text: 'Docs miss the new flag', file: 'docs/a.md', axis: 'Complete' },
        ...SAVED_RATING.findings.slice(1),
      ],
      warnBelow: 60,
    });
  });

  it('keeps the card values when both are saved, and the other cards beside them', () => {
    const saved = {
      confidence: { values: { asked: { type: 'line', text: 'Newer' } }, at: 5 },
      notes: { values: { note: { type: 'line', text: 'Hi' } }, at: 6 },
    };
    const cards = restoreRatedTaskCards(saved, structuredClone(SAVED_RATING));
    expect(cards?.confidence?.at).toBe(5);
    expect(Object.keys(cards ?? {})).toEqual(['confidence', 'notes']);
  });

  it('restores nothing, without throwing, from a broken saved rating', () => {
    expect(restoreRatedTaskCards(undefined, { scores: 'x' })).toBeUndefined();
    expect(restoreRatedTaskCards(undefined, null)).toBeUndefined();
    expect(restoreRatedTaskCards(undefined, undefined)).toBeUndefined();
  });

  it('keeps the longest question and key line confidence_publish accepts through a save', () => {
    const rating = {
      scores: [{ label: 'C', score: 70, why: 'x' }],
      findings: [],
      asked: 'a'.repeat(240),
      keyLine: { file: 'f'.repeat(300), line: 123456, why: 'here' },
    };
    const values = ratingCardValues(rating, { at: 3 });
    const restored = restoreTaskCards(JSON.parse(JSON.stringify({ confidence: values })));
    expect(cardConfidence(confidenceCard(true), restored?.confidence)).toMatchObject({
      asked: rating.asked,
      keyLine: rating.keyLine,
    });
  });

  it('round-trips a stored rating with its origin through a save', () => {
    const values = ratingCardValues(
      { scores: [{ label: 'C', score: 70, why: 'x' }], findings: [] },
      { at: 3, fingerprint: 'fp', origin: 'review', headSha: 'b'.repeat(40) },
    );
    const restored = restoreTaskCards(JSON.parse(JSON.stringify({ confidence: values })));
    expect(restored?.confidence).toEqual(values);
  });
});

describe('restoring the Confidence card definition', () => {
  it('gives an older saved definition, which had no slots, the default layout', () => {
    const [card] = restoreCardDefinitions([
      { id: 'confidence', enabled: true, pinned: ['scores'] },
    ]);
    expect(card.slots.map((slot) => [slot.id, slot.type, !!slot.hidden])).toEqual([
      ['scores', 'scores', false],
      ['findings', 'items', true],
      ['changes', 'items', true],
      ['keyLine', 'items', true],
      ['asked', 'line', true],
    ]);
    expect(card.pinned).toEqual(['scores']);
    expect(card.builtIn).toBe('confidence');
  });

  it('keeps a layout the user edited', () => {
    const [card] = restoreCardDefinitions([
      {
        id: 'confidence',
        name: 'Rating',
        enabled: true,
        slots: [{ id: 'scores', type: 'scores', label: 'Scores', warnBelow: 75 }],
      },
    ]);
    expect(card.name).toBe('Rating');
    expect(card.slots).toEqual([{ id: 'scores', type: 'scores', label: 'Scores', warnBelow: 75 }]);
  });
});

describe('restoring an edited Confidence layout', () => {
  it('never adds findings up across turns, and keeps the score bar at 60 or above', () => {
    const [card] = restoreCardDefinitions([
      {
        id: 'confidence',
        enabled: true,
        slots: [
          { id: 'scores', type: 'scores', label: 'Scores', warnBelow: 40 },
          { id: 'findings', type: 'items', label: 'Findings', addUp: true },
          { id: 'more', type: 'scores', label: 'More' },
        ],
      },
    ]);
    expect(card.slots).toEqual([
      { id: 'scores', type: 'scores', label: 'Scores', warnBelow: 60 },
      { id: 'findings', type: 'items', label: 'Findings' },
      { id: 'more', type: 'scores', label: 'More', warnBelow: 60 },
    ]);
  });
});

describe('cardConfidence', () => {
  it('reads parts whose slot the user removed as missing, and the bar from the score list', () => {
    const card = confidenceCard(true, [
      { id: 'scores', type: 'scores', label: 'Scores', warnBelow: 75 },
    ]);
    const values = restoreRatedTaskCards(undefined, structuredClone(SAVED_RATING))?.confidence;
    const rating = cardConfidence(card, values);
    expect(rating?.findings).toEqual([]);
    expect(rating?.changes).toBeUndefined();
    expect(rating?.warnBelow).toBe(75);
  });

  it('is undefined until the task is rated', () => {
    expect(cardConfidence(confidenceCard(true), undefined)).toBeUndefined();
  });
});

describe('holdsMergeEvidence', () => {
  it('needs the score list and the findings, each with its type', () => {
    expect(holdsMergeEvidence(confidenceCard(true))).toBe(true);
    const scoresOnly = confidenceCard(true, [{ id: 'scores', type: 'scores', label: 'S' }]);
    expect(holdsMergeEvidence(scoresOnly)).toBe(false);
    const retyped = confidenceCard(true, [
      { id: 'scores', type: 'scores', label: 'S' },
      { id: 'findings', type: 'checklist', label: 'F' },
    ]);
    expect(holdsMergeEvidence(retyped)).toBe(false);
  });
});

describe('isClassicRating', () => {
  it('tells a confidence_publish payload from slot-keyed values', () => {
    expect(isClassicRating({ scores: [{ label: 'C', score: 1, why: 'x' }] })).toBe(true);
    expect(isClassicRating({ findings: [{ kind: 'gap', text: 'x' }] })).toBe(true);
    expect(isClassicRating({ source: 'skill' })).toBe(true);
    expect(isClassicRating({ findings: [{ text: 'x', severity: 'warn' }] })).toBe(false);
    expect(isClassicRating({ scores: { scores: [] }, asked: 'x' })).toBe(false);
  });
});
