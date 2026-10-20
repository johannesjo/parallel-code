import { TOUR_CARD_LIMITS } from '../../electron/shared/understanding-limits';
import {
  BRANCH_OUTPUT,
  UNTRUSTED,
  cardInstructions,
  compactCard,
  withinBudget,
} from './understanding-prompt';
import { parseTourBranch, type TourCard } from './understanding-tour';

/**
 * "Write card" in a tour the reader writes: the agent turns their rough notes
 * on one card into a card written by the tour rules. What does not fit on it
 * comes back as more cards, which the app proposes as follow-ups to it.
 */
export function buildWriteCardPrompt(input: {
  /** The tour's own cards, for where the card sits in the argument. */
  roots: TourCard[];
  /** The cards above the one being written, outermost first. */
  above: TourCard[];
  card: TourCard;
}): string {
  const above = input.above.length
    ? `\nThe cards this card follows up on, outermost first, as compact JSON:\n${JSON.stringify(input.above.map(compactCard))}`
    : '';
  return withinBudget(`You help a developer think a problem through on small cards. They wrote rough notes on one card; write that card for them.
Return 1 to ${TOUR_CARD_LIMITS.branchMaxCards} cards. The first card is the card itself, rewritten. Keep the writer's meaning, language and terms, and add no facts they did not write. Every idea in the notes that does not fit on the first card becomes one more card, which the app offers as a follow-up to it: never drop an idea.
${cardInstructions(BRANCH_OUTPUT, { slides: true })}
Leave notes, source and refs out: whatever would go in notes becomes another card. label is a one- or two-word topic of the card.
${UNTRUSTED}
The tour's cards so far, as compact JSON:
${JSON.stringify(input.roots.map(compactCard))}${above}
The writer's card, as compact JSON:
${JSON.stringify(compactCard(input.card))}`);
}

/** The cards of a Write card answer, with only what a written card can hold. */
export function parseWrittenCards(response: string): TourCard[] {
  return parseTourBranch(response, 0, '').cards.map(
    ({ notes: _notes, source: _source, questions: _questions, ...card }) => ({ ...card, refs: [] }),
  );
}
