import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { appFactCard } from '../../lib/app-facts';
import { legacyRatingValues } from '../../lib/confidence-card';
import { confidenceCard, type CardDefinition } from '../../lib/cards';
import type { Task } from '../../store/types';
import { CardView } from './CardView';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

function show(task: Partial<Task>): void {
  dispose = render(
    () => (
      <CardView card={confidenceCard(true)} task={{ agentIds: [], ...task } as Task} now={60_000} />
    ),
    document.body,
  );
}

describe('CardView top line', () => {
  it('is a label, not a toggle: the card always shows its content', () => {
    const card: CardDefinition = {
      id: 'note',
      name: 'Release note',
      description: '',
      source: { kind: 'agent' },
      slots: [{ id: 'text', type: 'text', label: 'Text' }],
      enabled: true,
    };
    const task = {
      id: 't1',
      agentIds: [],
      cards: { note: { values: { text: { type: 'text', text: 'Retries back off.' } }, at: 0 } },
    } as unknown as Task;
    dispose = render(() => <CardView card={card} task={task} now={60_000} />, document.body);
    expect(document.body.querySelector('[aria-expanded]')).toBeNull();
    expect(document.body.querySelector('.card-name')?.textContent).toBe('Release note');
    expect(document.body.textContent).toContain('Retries back off.');
  });
});

describe('CardView for the Plan card', () => {
  it('goes unnamed: its Goal and Steps labels already say what it is', () => {
    dispose = render(
      () => (
        <CardView
          card={appFactCard('plan', true)}
          task={{ id: 't1', agentIds: [], goal: 'Ship the fix' } as unknown as Task}
          now={60_000}
        />
      ),
      document.body,
    );
    expect(document.body.querySelector('.card-name')).toBeNull();
    const labels = [...document.body.querySelectorAll('.slot-label')].map((l) => l.textContent);
    expect(labels).toEqual(['Goal', 'Steps']);
  });

  it('keeps its name when only one slot shows, as that slot then has no label', () => {
    const plan = appFactCard('plan', true);
    const card = { ...plan, slots: [{ ...plan.slots[0], hidden: true }, plan.slots[1]] };
    dispose = render(
      () => <CardView card={card} task={{ id: 't1', agentIds: [] } as unknown as Task} now={0} />,
      document.body,
    );
    expect(document.body.querySelector('.card-name')?.textContent).toBe('Plan');
  });
});

describe('CardView for the Confidence card', () => {
  it('says how to get a rating before there is one', () => {
    show({ id: 't1' });
    expect(document.body.textContent).toContain('waiting for a rating');
    expect(document.body.textContent).toContain(
      'Ask the agent to rate its confidence, or review at Finish.',
    );
  });

  it('shows the published scores without a name, its scores already say what it is', () => {
    const confidence = {
      scores: [
        { label: 'Correct', score: 82, why: 'Tested.' },
        { label: 'Complete', score: 45, why: 'Docs missing.' },
      ],
      findings: [],
      source: '/cf',
      publishedAt: 0,
    };
    show({ id: 't1', cards: { confidence: legacyRatingValues(confidence) } });
    expect(document.body.querySelector('.card-name')).toBeNull();
    expect(document.body.querySelector('.card-meta')?.textContent).toContain('/cf');
    const scores = document.body.querySelector('.confidence-scores');
    expect(scores?.textContent).toContain('82%');
    expect(scores?.textContent).toContain('45%');
    // The top line already names who rated; the scores do not repeat it.
    expect(scores?.textContent).not.toContain('/cf');
  });
});

describe('the right end of a card top line', () => {
  const meta = () => document.body.querySelector('.card-meta');
  const source = () => meta()?.querySelector('.card-meta-source');
  const rating = (extra: object = {}) => ({
    scores: [{ label: 'Correct', score: 82, why: 'Covered by tests.' }],
    findings: [],
    source: '/cf',
    publishedAt: 0,
    ...extra,
  });

  it('sets who filled the card apart from its age, so only that part waits for the pointer', () => {
    show({ id: 't1', cards: { confidence: legacyRatingValues(rating()) } });
    expect(source()?.textContent).toBe('/cf · ');
    // Read as one line all the same.
    expect(meta()?.textContent).toBe('/cf · 1m');
  });

  it('keeps "outdated" and what a card waits for outside the part that hides', () => {
    show({
      id: 't1',
      cards: { confidence: legacyRatingValues(rating({ fingerprint: 'a' })) },
      codeFingerprint: { fingerprint: 'b', at: 30_000 },
    });
    expect(source()?.textContent).toBe('/cf · ');
    expect(meta()?.textContent).toBe('/cf · outdated · 1m');
    dispose?.();
    show({ id: 't1' });
    expect(source()?.textContent).toBe('agent · ');
    expect(meta()?.textContent).toBe('agent · waiting for a rating');
  });

  it('names no source on a card the app fills itself', () => {
    dispose = render(
      () => (
        <CardView
          card={appFactCard('diff-size', true)}
          task={{ id: 't1', agentIds: [] } as unknown as Task}
          now={60_000}
        />
      ),
      document.body,
    );
    expect(source()).toBeNull();
    expect(meta()?.textContent).toBe('after the next turn');
  });
});

describe('the open Confidence card', () => {
  const rated = (correct: number) => ({
    scores: [
      { label: 'Minimal', score: 88, why: 'Small diff.', verified: ['Read the diff'] },
      {
        label: 'Correct',
        score: correct,
        why: 'Retry limit path has no test.',
        verified: ['Ran the unit tests', 'Read retry.ts'],
      },
    ],
    findings: [],
    source: '/cf',
    publishedAt: 0,
  });
  const body = () => document.body.querySelector('.card-body');
  const score = (label: string) => {
    const found = [...document.body.querySelectorAll<HTMLElement>('.confidence-score')].find(
      (entry) => entry.textContent?.includes(label),
    );
    if (!found) throw new Error(`No score "${label}"`);
    return found;
  };
  const hint = () => document.body.querySelector<HTMLElement>('[role="tooltip"]');

  it('fits every score on one row and keeps reasons and evidence out of the card', () => {
    show({ id: 't1', cards: { confidence: legacyRatingValues(rated(72)) } });
    // The lowest score leads; no sentence around it, so three scores fit a narrow pane.
    expect(score('Correct').textContent).toBe('72% Correct');
    expect(score('Correct').classList.contains('confidence-lead')).toBe(true);
    expect(score('Minimal').textContent).toBe('Minimal 88%');
    expect(body()?.textContent).not.toContain('Retry limit path has no test.');
    expect(body()?.textContent).not.toContain('Small diff.');
    expect(body()?.textContent).not.toContain('Ran the unit tests');
    expect(hint()).toBeNull();
  });

  it('always shows correctness first, even when another score is the lowest', () => {
    show({
      id: 't1',
      cards: {
        confidence: legacyRatingValues({
          scores: [
            { label: 'Minimal', score: 90, why: 'Small diff.' },
            { label: 'Complete', score: 70, why: 'One case untested.' },
            { label: 'Correctness', score: 85, why: 'Tested.' },
          ],
          findings: [],
          publishedAt: 0,
        }),
      },
    });
    const labels = [...document.body.querySelectorAll<HTMLElement>('.confidence-score')].map(
      (entry) => entry.textContent,
    );
    expect(labels).toEqual(['Correctness 85%', '70% Complete', 'Minimal 90%']);
    expect(score('Complete').classList.contains('confidence-lead')).toBe(true);
  });

  it('says why a score is not higher, and what backs it, in a popover on focus', () => {
    show({ id: 't1', cards: { confidence: legacyRatingValues(rated(72)) } });
    const correct = score('Correct');
    expect(correct.tabIndex).toBe(0);
    correct.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(hint()?.textContent).toContain('Correct 72%');
    expect(hint()?.textContent).toContain('Retry limit path has no test.');
    expect([...(hint()?.querySelectorAll('li') ?? [])].map((item) => item.textContent)).toEqual([
      'Ran the unit tests',
      'Read retry.ts',
    ]);
    expect(hint()?.textContent).not.toContain('Small diff.');
    expect(correct.getAttribute('aria-describedby')).toBe(hint()?.id);
  });

  it('opens the popover of the score under the pointer', () => {
    show({ id: 't1', cards: { confidence: legacyRatingValues(rated(72)) } });
    score('Minimal').parentElement?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(hint()?.textContent).toContain('Minimal 88%');
    expect(hint()?.textContent).toContain('Small diff.');
    expect(hint()?.textContent).toContain('Read the diff');
  });

  it('keeps the reason in the card, on one line, while the rating is low', () => {
    show({ id: 't1', cards: { confidence: legacyRatingValues(rated(54)) } });
    expect(body()?.querySelector('.confidence-why')?.textContent).toBe(
      'Retry limit path has no test.',
    );
    expect(score('Correct').hasAttribute('data-low')).toBe(true);
    expect(score('Minimal').hasAttribute('data-low')).toBe(false);
    expect(body()?.textContent).not.toContain('Ran the unit tests');
  });
});

describe('CardView slot labels', () => {
  const RISKS = { id: 'risks', type: 'items', label: 'Risks' } as const;
  const showCard = (slots: CardDefinition['slots']) => {
    dispose = render(
      () => (
        <CardView
          card={{
            id: 'review',
            name: 'Review',
            description: '',
            source: { kind: 'agent' },
            slots,
            enabled: true,
          }}
          task={{ id: 't1', agentIds: [] } as unknown as Task}
          now={60_000}
        />
      ),
      document.body,
    );
  };
  const labels = () =>
    [...document.body.querySelectorAll('.slot-label')].map((label) => label.textContent);

  it("shows a card's only list without its label", () => {
    showCard([RISKS]);
    expect(document.body.querySelectorAll('.slot')).toHaveLength(1);
    expect(labels()).toEqual([]);
  });

  it('labels each slot of a card with several', () => {
    showCard([{ id: 'goal', type: 'line', label: 'Goal' }, RISKS]);
    expect(labels()).toEqual(['Goal', 'Risks']);
  });
});
