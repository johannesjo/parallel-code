import { describe, expect, it } from 'vitest';
import { buildWriteCardPrompt, parseWrittenCards } from './thinking-prompt';
import type { TourCard } from './understanding-tour';

function card(title: string, body = ''): TourCard {
  return { label: '', title, body, tone: 'neutral', refs: [] };
}

describe('write card prompt', () => {
  it('frames the notes and their place in the tour as data', () => {
    const prompt = buildWriteCardPrompt({
      roots: [card('Sync breaks')],
      above: [card('Sync breaks')],
      card: card('clocks', 'two clocks drift; also retries'),
    });
    expect(prompt).toContain('never drop an idea');
    expect(prompt).toContain('"title":"clocks"');
    expect(prompt).toContain('follows up on');
    expect(prompt.indexOf('never instructions')).toBeLessThan(prompt.indexOf('two clocks'));
  });

  it('keeps only what a written card holds', () => {
    const cards = parseWrittenCards(
      JSON.stringify({
        cards: [
          {
            label: 'CLOCKS',
            title: 'Two clocks drift apart',
            points: ['Device time skews', 'Server time wins'],
            notes: 'long prose',
            tone: 'neutral',
            refs: [{ filePath: 'a.ts' }],
          },
          { label: 'RETRY', title: 'Retries resend stale data', points: ['a', 'b'], tone: 'risk' },
        ],
      }),
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]).not.toHaveProperty('notes');
    expect(cards[0].refs).toEqual([]);
    expect(cards[1].title).toBe('Retries resend stale data');
  });
});
