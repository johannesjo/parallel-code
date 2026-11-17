import { describe, expect, it } from 'vitest';
import { revealCard } from './flash';

describe('revealCard', () => {
  it('lands on the card asked for and points it out', () => {
    document.body.innerHTML = `
      <section class="card" data-card-id="plan" tabindex="-1"></section>
      <section class="card" data-card-id="activity" tabindex="-1"></section>`;
    revealCard(document.body, 'activity');
    const card = document.querySelector('[data-card-id="activity"]');
    expect(document.activeElement).toBe(card);
    expect(card?.hasAttribute('data-flash')).toBe(true);
    expect(document.querySelector('[data-card-id="plan"]')?.hasAttribute('data-flash')).toBe(false);
  });

  it('does nothing for a card that is not shown', () => {
    document.body.innerHTML = '<section class="card" data-card-id="plan" tabindex="-1"></section>';
    expect(() => revealCard(document.body, 'activity')).not.toThrow();
  });
});
