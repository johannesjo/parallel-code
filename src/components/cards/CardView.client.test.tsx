import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { appFactCard } from '../../lib/app-facts';
import { confidenceCard, type CardDefinition } from '../../lib/cards';
import type { Task } from '../../store/types';
import { CardView } from './CardView';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

function show(task: Partial<Task>, expanded = true): void {
  dispose = render(
    () => (
      <CardView
        card={confidenceCard(true)}
        task={{ agentIds: [], ...task } as Task}
        expanded={expanded}
        now={60_000}
      />
    ),
    document.body,
  );
}

describe('CardView open state', () => {
  it('follows whether it should start open until the user toggles it', () => {
    const [expanded, setExpanded] = createSignal(false);
    dispose = render(
      () => (
        <CardView
          card={confidenceCard(true)}
          task={{ id: 't1', agentIds: [] } as unknown as Task}
          expanded={expanded()}
          now={60_000}
        />
      ),
      document.body,
    );
    const toggle = () => document.body.querySelector<HTMLButtonElement>('.card-toggle');
    setExpanded(true);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    toggle()?.click();
    setExpanded(false);
    setExpanded(true);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('CardView for the Confidence card', () => {
  it('says how to get a rating before there is one', () => {
    show({ id: 't1' });
    expect(document.body.textContent).toContain('waiting for a rating');
    expect(document.body.textContent).toContain('run a rating skill such as /cf');
  });

  it('shows the published scores, with a summary on the closed line', () => {
    const confidence = {
      scores: [
        { label: 'Correct', score: 82, why: 'Tested.' },
        { label: 'Complete', score: 45, why: 'Docs missing.' },
      ],
      findings: [],
      source: '/cf',
      publishedAt: 0,
    };
    show({ id: 't1', confidence }, false);
    const toggle = document.body.querySelector('.card-toggle');
    expect(toggle?.textContent).toContain('Correct 82 · Complete 45');
    expect(toggle?.textContent).toContain('/cf');
    (toggle as HTMLButtonElement).click();
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
    show({ id: 't1', confidence: rating() });
    expect(source()?.textContent).toBe('/cf · ');
    // Read as one line all the same.
    expect(meta()?.textContent).toBe('/cf · 1m');
  });

  it('keeps "outdated" and what a card waits for outside the part that hides', () => {
    show({
      id: 't1',
      confidence: rating({ fingerprint: 'a' }),
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
          expanded
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
    show({ id: 't1', confidence: rated(72) });
    // The lowest score leads; no sentence around it, so three scores fit a narrow pane.
    expect(score('Correct').textContent).toBe('72% Correct');
    expect(score('Correct').classList.contains('confidence-lead')).toBe(true);
    expect(score('Minimal').textContent).toBe('Minimal 88%');
    expect(body()?.textContent).not.toContain('Retry limit path has no test.');
    expect(body()?.textContent).not.toContain('Small diff.');
    expect(body()?.textContent).not.toContain('Ran the unit tests');
    expect(hint()).toBeNull();
  });

  it('says why a score is not higher, and what backs it, in a popover on focus', () => {
    show({ id: 't1', confidence: rated(72) });
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
    show({ id: 't1', confidence: rated(72) });
    score('Minimal').parentElement?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(hint()?.textContent).toContain('Minimal 88%');
    expect(hint()?.textContent).toContain('Small diff.');
    expect(hint()?.textContent).toContain('Read the diff');
  });

  it('keeps the reason in the card, on one line, while the rating is low', () => {
    show({ id: 't1', confidence: rated(54) });
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
          expanded
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
