import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TourTone } from '../../lib/understanding-tour';
import { TourCard } from './TourCard';

vi.mock('../../lib/mermaid', () => ({ renderMermaidIn: vi.fn() }));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

function mountCard(tone: TourTone): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const card = { label: 'PLUMBING', title: 'Title', body: 'Body text.', tone, refs: [] };
  dispose = render(() => <TourCard card={card} />, host);
  const article = host.querySelector('article');
  if (!article) throw new Error('card not rendered');
  return article;
}

describe('TourCard', () => {
  it('keeps a source quote behind a collapsed disclosure', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const card = {
      label: 'KEY DECISION',
      title: 'Title',
      body: 'Body text.',
      tone: 'neutral' as const,
      source: 'We keep the buffer before IPC.',
      refs: [],
    };
    dispose = render(() => <TourCard card={card} omitted={['Appendix', 'Rollout']} />, host);
    const details = host.querySelector('details.understanding-source');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Source');
    expect(details?.querySelector('blockquote')?.textContent).toBe(card.source);
    expect(host.querySelector('.understanding-omitted')?.textContent).toBe(
      'Not covered: Appendix, Rollout',
    );
  });

  it('shows neither a quote nor an omitted line when there is none', () => {
    const article = mountCard('neutral');
    expect(article.querySelector('.understanding-source')).toBeNull();
    expect(article.querySelector('.understanding-omitted')).toBeNull();
  });

  it.each<TourTone>(['neutral', 'important', 'risk', 'uncertainty', 'mechanical'])(
    'reads %s cards at full text contrast',
    (tone) => {
      expect(mountCard(tone).style.color).toBe('var(--fg)');
    },
  );
});
